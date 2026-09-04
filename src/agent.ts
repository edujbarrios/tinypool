import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import Tinypool from './index'
import type { TinypoolChannel } from './common'

export type AgentCapability = string

export interface AgentLimits {
  timeout?: number
  maxToolCalls?: number
}

export interface AgentToolContext {
  agentId: string
  capabilities: ReadonlySet<AgentCapability>
  signal?: AbortSignal
}

export interface AgentTool<TInput = unknown, TOutput = unknown> {
  name: string
  description?: string
  capabilities?: readonly AgentCapability[]
  execute(input: TInput, context: AgentToolContext): TOutput | Promise<TOutput>
}

export class AgentPermissionError extends Error {
  constructor(tool: string, capability: string) {
    super(`Tool "${tool}" requires capability "${capability}"`)
    this.name = 'AgentPermissionError'
  }
}

export class AgentToolLimitError extends Error {
  constructor(limit: number) {
    super(`Agent exceeded the tool call limit of ${limit}`)
    this.name = 'AgentToolLimitError'
  }
}

export class ToolRegistry {
  #tools = new Map<string, AgentTool>()

  constructor(tools: readonly AgentTool[] = []) {
    for (const tool of tools) this.register(tool)
  }

  register(tool: AgentTool): this {
    if (!tool.name) throw new TypeError('tool.name must be a non-empty string')
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`)
    }
    this.#tools.set(tool.name, tool)
    return this
  }

  unregister(name: string): boolean {
    return this.#tools.delete(name)
  }

  has(name: string): boolean {
    return this.#tools.has(name)
  }

  get(name: string): AgentTool | undefined {
    return this.#tools.get(name)
  }

  list(): AgentTool[] {
    return Array.from(this.#tools.values())
  }

  async invoke<TOutput = unknown>(
    name: string,
    input: unknown,
    context: AgentToolContext
  ): Promise<TOutput> {
    const tool = this.#tools.get(name)
    if (!tool) throw new Error(`Unknown tool "${name}"`)

    for (const capability of tool.capabilities ?? []) {
      if (!context.capabilities.has(capability)) {
        throw new AgentPermissionError(name, capability)
      }
    }

    if (context.signal?.aborted) {
      throw context.signal.reason ?? new Error('Agent execution aborted')
    }

    return (await tool.execute(input, context)) as TOutput
  }
}

export interface AgentContextOptions {
  agentId?: string
  capabilities?: readonly AgentCapability[]
  limits?: AgentLimits
  signal?: AbortSignal
}

export class AgentContext {
  readonly id: string
  readonly capabilities: ReadonlySet<AgentCapability>
  readonly signal?: AbortSignal
  readonly limits: Readonly<AgentLimits>
  readonly tools: ToolRegistry
  #toolCalls = 0

  constructor(tools: ToolRegistry, options: AgentContextOptions = {}) {
    this.tools = tools
    this.id = options.agentId ?? randomUUID()
    this.capabilities = new Set(options.capabilities ?? [])
    this.signal = options.signal
    this.limits = Object.freeze({ ...options.limits })
  }

  get toolCalls(): number {
    return this.#toolCalls
  }

  async tool<TOutput = unknown>(name: string, input?: unknown): Promise<TOutput> {
    const maxToolCalls = this.limits.maxToolCalls
    if (maxToolCalls !== undefined && this.#toolCalls >= maxToolCalls) {
      throw new AgentToolLimitError(maxToolCalls)
    }

    this.#toolCalls++
    return this.tools.invoke<TOutput>(name, input, {
      agentId: this.id,
      capabilities: this.capabilities,
      signal: this.signal,
    })
  }
}

export interface AgentDescriptor {
  id: string
  capabilities: readonly AgentCapability[]
  limits: Readonly<AgentLimits>
}

export interface AgentTaskEnvelope<TInput = unknown> {
  input: TInput
  agent: AgentDescriptor
}

export interface AgentRunOptions {
  agentId?: string
  filename?: string | null
  name?: string | null
  runtime?: 'worker_threads' | 'child_process'
  signal?: AbortSignal | null
  channel?: TinypoolChannel
  capabilities?: readonly AgentCapability[]
  limits?: AgentLimits
}

export interface AgentPoolOptions {
  pool?: ConstructorParameters<typeof Tinypool>[0]
  tools?: readonly AgentTool[]
  capabilities?: readonly AgentCapability[]
  limits?: AgentLimits
}

export interface AgentRunEvent<TInput = unknown> {
  agent: AgentDescriptor
  input: TInput
}

export class AgentPool extends EventEmitter {
  readonly pool: Tinypool
  readonly tools: ToolRegistry
  readonly capabilities: readonly AgentCapability[]
  readonly limits: Readonly<AgentLimits>

  constructor(options: AgentPoolOptions = {}) {
    super()
    this.pool = new Tinypool(options.pool)
    this.tools = new ToolRegistry(options.tools)
    this.capabilities = Object.freeze([...(options.capabilities ?? [])])
    this.limits = Object.freeze({ ...options.limits })
  }

  createContext(options: AgentContextOptions = {}): AgentContext {
    return new AgentContext(this.tools, {
      agentId: options.agentId,
      capabilities: options.capabilities ?? this.capabilities,
      limits: { ...this.limits, ...options.limits },
      signal: options.signal,
    })
  }

  async run<TInput = unknown, TResult = unknown>(
    input: TInput,
    options: AgentRunOptions = {}
  ): Promise<TResult> {
    const limits = Object.freeze({ ...this.limits, ...options.limits })
    const agent: AgentDescriptor = {
      id: options.agentId ?? randomUUID(),
      capabilities: Object.freeze([
        ...(options.capabilities ?? this.capabilities),
      ]),
      limits,
    }
    const envelope: AgentTaskEnvelope<TInput> = { input, agent }
    const controller = new AbortController()
    const externalSignal = options.signal
    let timeout: NodeJS.Timeout | undefined

    const abortFromExternal = () => controller.abort(externalSignal?.reason)
    if (externalSignal) {
      if (externalSignal.aborted) abortFromExternal()
      else externalSignal.addEventListener('abort', abortFromExternal, { once: true })
    }

    if (limits.timeout !== undefined) {
      timeout = setTimeout(
        () => controller.abort(new Error(`Agent timed out after ${limits.timeout}ms`)),
        limits.timeout
      )
      timeout.unref?.()
    }

    this.emit('agent:start', { agent, input } satisfies AgentRunEvent<TInput>)

    try {
      const result = (await this.pool.run(envelope, {
        filename: options.filename,
        name: options.name,
        runtime: options.runtime,
        signal: controller.signal,
        channel: options.channel,
      })) as TResult
      this.emit('agent:finish', { agent, input, result })
      return result
    } catch (error) {
      this.emit('agent:error', { agent, input, error })
      throw error
    } finally {
      if (timeout) clearTimeout(timeout)
      externalSignal?.removeEventListener('abort', abortFromExternal)
    }
  }

  async destroy(): Promise<void> {
    await this.pool.destroy()
  }
}

export function defineAgent<TInput, TResult>(
  handler: (
    task: AgentTaskEnvelope<TInput>
  ) => TResult | Promise<TResult>
): typeof handler {
  return handler
}

export default AgentPool
