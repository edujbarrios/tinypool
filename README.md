# Tinypool Agent Runtime 🧵🤖

An experimental fork of [tinylibs/tinypool](https://github.com/tinylibs/tinypool) focused on running AI-agent workloads, isolated tools and concurrent tasks in Node.js.

The original Tinypool worker-pool API stays available. This fork adds a higher-level agent runtime on top of it instead of replacing the worker engine.

## Why this fork?

AI agents need more than parallel execution. They also need execution identity, capability boundaries, tool-call limits, cancellation, lifecycle events and a clean path toward isolated tool execution.

This fork keeps Tinypool's small worker runtime and adds those primitives incrementally.

### Current agent features

- ✅ `AgentPool` built on top of Tinypool
- ✅ `worker_threads` and `child_process` runtimes
- ✅ Agent identity and execution envelopes
- ✅ Capability-based tool permissions
- ✅ `ToolRegistry`
- ✅ Per-agent tool-call limits
- ✅ Execution timeouts and cancellation
- ✅ Agent lifecycle events (`agent:start`, `agent:finish`, `agent:error`)
- ✅ Typed `defineAgent()` helper
- ✅ Existing Tinypool API remains available
- 🚧 Main ↔ worker tool RPC over `TinypoolChannel`
- 🚧 Persistent agent sessions
- 🚧 Remote / container runtimes
- 🚧 Agent-to-agent messaging and scheduling

## Agent runtime

Import the new runtime from the `tinypool/agent` subpath.

```ts
import { AgentPool } from 'tinypool/agent'

const agents = new AgentPool({
  pool: {
    maxThreads: 4,
  },
  capabilities: ['repo.read'],
  limits: {
    timeout: 30_000,
    maxToolCalls: 20,
  },
})
```

### Register tools

Tools can declare the capabilities required to invoke them.

```ts
agents.tools.register({
  name: 'read-file',
  capabilities: ['filesystem.read'],
  async execute({ path }) {
    return readFile(path, 'utf8')
  },
})
```

Create an agent context with explicit permissions:

```ts
const context = agents.createContext({
  agentId: 'researcher',
  capabilities: ['filesystem.read'],
})

const contents = await context.tool('read-file', {
  path: './README.md',
})
```

If an agent does not have the required capability, the runtime throws `AgentPermissionError` before the tool executes.

### Run an agent in the worker pool

Agent jobs are wrapped in a serializable execution envelope containing the input plus agent metadata.

```ts
const result = await agents.run(
  { prompt: 'Analyze this repository' },
  {
    agentId: 'repo-researcher',
    filename: new URL('./research-agent.mjs', import.meta.url).href,
    capabilities: ['repo.read'],
    limits: {
      timeout: 60_000,
      maxToolCalls: 30,
    },
  }
)
```

Worker:

```ts
import { defineAgent } from 'tinypool/agent'

export default defineAgent(async ({ input, agent }) => {
  return {
    agentId: agent.id,
    prompt: input.prompt,
    capabilities: agent.capabilities,
  }
})
```

The envelope is intentionally model-provider agnostic. OpenAI, Anthropic, local models or custom orchestration code can live inside the worker without coupling the pool to one SDK.

### Lifecycle events

```ts
agents.on('agent:start', ({ agent }) => {
  console.log('started', agent.id)
})

agents.on('agent:finish', ({ agent }) => {
  console.log('finished', agent.id)
})

agents.on('agent:error', ({ agent, error }) => {
  console.error('failed', agent.id, error)
})
```

## Architecture direction

```text
AgentPool
├── Tinypool worker scheduler
├── Agent execution envelopes
├── ToolRegistry
├── Capability checks
├── Execution limits
├── Lifecycle events
└── TinypoolChannel
    └── future tool RPC / agent messaging
```

The important design rule is that the worker-pool core stays useful independently of the agent layer. Agent-specific functionality is exposed through `tinypool/agent`.

## Original Tinypool API

The original API is still available:

```js
import Tinypool from 'tinypool'

const pool = new Tinypool({
  filename: new URL('./worker.mjs', import.meta.url).href,
})

const result = await pool.run({ a: 4, b: 6 })
console.log(result) // 10

await pool.destroy()
```

Worker:

```js
export default ({ a, b }) => a + b
```

Tinypool supports both `worker_threads` and `child_process` and provides communication primitives between the parent process and workers.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Node.js requirements follow the current upstream package configuration: Node.js 20 or newer supported ranges.

## Fork policy

This repository is intentionally allowed to diverge from upstream Tinypool as the agent runtime evolves. Upstream fixes and improvements can still be incorporated when useful, but agent-specific features are not being developed with the expectation that they will be merged into `tinylibs/tinypool`.

## Roadmap

The next useful milestones are:

1. Tool RPC over the existing `TinypoolChannel`, so workers can request privileged tools from the parent process without serializing executable functions.
2. Persistent agent sessions with scoped state.
3. Per-tool timeout, concurrency and audit hooks.
4. Stronger isolation policies for `child_process` agents.
5. Optional remote/container runtime adapters.
6. Agent scheduling, priorities and sub-agent orchestration.

## Credits

This project is a personal fork of [Tinypool](https://github.com/tinylibs/tinypool), which itself originated as a smaller fork of [Piscina](https://github.com/piscinajs/piscina).

The original Tinypool project and its contributors remain the foundation of the worker-pool implementation.

## License

MIT. See [LICENSE](./LICENSE).
