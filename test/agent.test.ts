import { describe, expect, test, vi } from 'vitest'
import {
  AgentContext,
  AgentPermissionError,
  AgentToolLimitError,
  ToolRegistry,
  defineAgent,
} from '../src/agent'

describe('ToolRegistry', () => {
  test('registers and invokes tools', async () => {
    const execute = vi.fn(({ value }: { value: number }) => value * 2)
    const registry = new ToolRegistry([
      {
        name: 'double',
        execute,
      },
    ])

    const result = await registry.invoke<number>('double', { value: 21 }, {
      agentId: 'agent-1',
      capabilities: new Set(),
    })

    expect(result).toBe(42)
    expect(execute).toHaveBeenCalledOnce()
  })

  test('rejects tools when a required capability is missing', async () => {
    const registry = new ToolRegistry([
      {
        name: 'shell',
        capabilities: ['shell.execute'],
        execute: () => 'ok',
      },
    ])

    await expect(
      registry.invoke('shell', {}, {
        agentId: 'agent-1',
        capabilities: new Set(['filesystem.read']),
      })
    ).rejects.toBeInstanceOf(AgentPermissionError)
  })

  test('rejects duplicate tool names', () => {
    const registry = new ToolRegistry([
      { name: 'search', execute: () => null },
    ])

    expect(() =>
      registry.register({ name: 'search', execute: () => null })
    ).toThrow('already registered')
  })
})

describe('AgentContext', () => {
  test('tracks tool calls and enforces maxToolCalls', async () => {
    const registry = new ToolRegistry([
      { name: 'ping', execute: () => 'pong' },
    ])
    const context = new AgentContext(registry, {
      agentId: 'agent-1',
      limits: { maxToolCalls: 1 },
    })

    await expect(context.tool('ping')).resolves.toBe('pong')
    expect(context.toolCalls).toBe(1)
    await expect(context.tool('ping')).rejects.toBeInstanceOf(
      AgentToolLimitError
    )
  })

  test('passes capabilities and identity to tools', async () => {
    const registry = new ToolRegistry([
      {
        name: 'inspect-context',
        capabilities: ['repo.read'],
        execute: (_input, context) => ({
          agentId: context.agentId,
          canReadRepo: context.capabilities.has('repo.read'),
        }),
      },
    ])
    const context = new AgentContext(registry, {
      agentId: 'researcher',
      capabilities: ['repo.read'],
    })

    await expect(context.tool('inspect-context')).resolves.toEqual({
      agentId: 'researcher',
      canReadRepo: true,
    })
  })
})

test('defineAgent preserves a typed agent handler', async () => {
  const handler = defineAgent<{ prompt: string }, string>(
    async ({ input, agent }) => `${agent.id}:${input.prompt}`
  )

  await expect(
    handler({
      input: { prompt: 'hello' },
      agent: { id: 'coder', capabilities: [], limits: {} },
    })
  ).resolves.toBe('coder:hello')
})
