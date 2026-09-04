# Tinypool Agent Runtime

> A lightweight Node.js worker pool evolving into an execution runtime for AI agents, tools and isolated workloads.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%5E20%20%7C%7C%20%3E%3D22-brightgreen.svg)](./package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-first-3178c6.svg)](https://www.typescriptlang.org/)

This repository is a personal fork of [tinylibs/tinypool](https://github.com/tinylibs/tinypool). It preserves Tinypool's compact worker-pool API while adding a higher-level execution layer designed for AI-agent workloads.

The goal is not to turn a worker pool into an LLM framework. The goal is to provide the runtime underneath one: scheduling, isolation, execution identity, permissions, limits, lifecycle events and eventually safe tool RPC between isolated workers and the parent process.

## Why this exists

Most agent frameworks focus on prompts, models, tools and workflow orchestration. They still need somewhere to execute work safely and concurrently.

Tinypool already provides a strong foundation:

- fast worker reuse
- `worker_threads` and `child_process`
- task queues and concurrency control
- cancellation
- worker recycling and isolation
- parent ↔ worker communication primitives
- no runtime dependencies

This fork builds agent-oriented primitives on top of that foundation without breaking the original `Tinypool` API.

## Status

The agent layer is experimental and intentionally evolving independently from upstream Tinypool.

| Capability | Status |
| --- | --- |
| Existing Tinypool API | ✅ Stable foundation |
| `AgentPool` execution layer | ✅ Available |
| Agent identity / execution envelopes | ✅ Available |
| `ToolRegistry` | ✅ Available |
| Capability-based tool permissions | ✅ Available |
| Tool-call limits | ✅ Available |
| Agent execution timeout | ✅ Available |
| Cancellation via `AbortSignal` | ✅ Available |
| Agent lifecycle events | ✅ Available |
| `worker_threads` runtime | ✅ Available |
| `child_process` runtime | ✅ Available |
| Parent ↔ worker tool RPC | 🚧 Next milestone |
| Persistent sessions | 🧭 Planned |
| Per-tool policies and audit hooks | 🧭 Planned |
| Remote / container runtimes | 🧭 Planned |
| Sub-agent orchestration | 🧭 Planned |

## Installation

This fork is currently developed directly from GitHub. The upstream npm package name remains `tinypool`, so publishing strategy for the fork should be decided before releasing it to npm.

```bash
git clone https://github.com/edujbarrios/tinypool.git
cd tinypool
pnpm install
pnpm build
```

## Quick start: Agent runtime

Import the agent layer through the dedicated subpath:

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

### Define tools

Tools are registered in the parent runtime and can declare explicit capabilities.

```ts
import { readFile } from 'node:fs/promises'

agents.tools.register({
  name: 'filesystem.read',
  description: 'Read a UTF-8 file from disk',
  capabilities: ['filesystem.read'],
  async execute({ path }) {
    return readFile(path, 'utf8')
  },
})
```

Create a context with only the permissions that agent should have:

```ts
const context = agents.createContext({
  agentId: 'repository-researcher',
  capabilities: ['filesystem.read'],
  limits: {
    maxToolCalls: 10,
  },
})

const readme = await context.tool('filesystem.read', {
  path: './README.md',
})
```

If the context lacks a required capability, the tool is rejected before execution with `AgentPermissionError`.

## Run work inside the pool

`AgentPool.run()` wraps input in a serializable execution envelope containing agent metadata.

```ts
const result = await agents.run(
  {
    prompt: 'Analyze this repository and return a concise architecture summary.',
  },
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
    capabilities: agent.capabilities,
    request: input.prompt,
  }
})
```

The execution envelope is deliberately model-provider agnostic. OpenAI, Anthropic, local models or custom orchestration code can be used without coupling this runtime to one SDK.

## Runtime model

```text
Application / Agent Framework
          │
          ▼
      AgentPool
          │
   ┌──────┼──────────────────────┐
   │      │                      │
   ▼      ▼                      ▼
Identity  Limits            ToolRegistry
   │      │                      │
   └──────┴──────────┬───────────┘
                     ▼
               Tinypool Core
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
   worker_threads         child_process
          │                     │
          └──────────┬──────────┘
                     ▼
               Agent workload
```

The core design rule is simple: **agent functionality lives above Tinypool, not inside its scheduling engine unless the runtime genuinely requires it.**

That keeps the original worker pool useful independently and reduces divergence from upstream where possible.

## Capabilities and least privilege

Capabilities are strings representing permissions granted to an agent context.

```ts
const context = agents.createContext({
  capabilities: [
    'filesystem.read',
    'github.read',
  ],
})
```

A tool can require one or more capabilities:

```ts
agents.tools.register({
  name: 'github.create-commit',
  capabilities: ['github.write'],
  async execute(input, context) {
    // privileged operation
  },
})
```

A read-only agent cannot invoke that tool unless `github.write` was explicitly granted.

Capabilities are not a sandbox by themselves. They are an authorization primitive. Strong isolation still depends on the runtime boundary (`worker_threads`, `child_process`, and future container/remote adapters) and on which privileged operations remain in the parent process.

## Execution limits

Agent contexts can enforce tool-call budgets:

```ts
const context = agents.createContext({
  limits: {
    maxToolCalls: 5,
  },
})
```

Pool executions can also enforce a wall-clock timeout:

```ts
await agents.run(input, {
  filename: workerFile,
  limits: {
    timeout: 15_000,
  },
})
```

External cancellation can be propagated with an `AbortSignal`.

```ts
const controller = new AbortController()

const task = agents.run(input, {
  filename: workerFile,
  signal: controller.signal,
})

controller.abort()
await task
```

## Lifecycle events

The runtime exposes events suitable for logging, metrics and tracing adapters.

```ts
agents.on('agent:start', ({ agent }) => {
  console.log('started', agent.id)
})

agents.on('agent:finish', ({ agent, result }) => {
  console.log('finished', agent.id, result)
})

agents.on('agent:error', ({ agent, error }) => {
  console.error('failed', agent.id, error)
})
```

## Original Tinypool API remains available

Nothing requires using the agent abstraction.

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

## Security direction

The intended architecture keeps privileged tools in the parent process whenever possible.

A future worker should be able to request:

```text
worker: "call github.read with these arguments"
```

instead of receiving an executable GitHub function inside the worker.

The parent runtime can then:

1. identify the requesting agent
2. validate its capabilities
3. enforce tool policy and limits
4. execute the privileged operation
5. emit audit/tracing events
6. return only the serialized result

The existing `TinypoolChannel` is the natural transport for this RPC layer.

## Roadmap

### Phase 1 — Runtime primitives

- [x] `AgentPool`
- [x] `AgentContext`
- [x] `ToolRegistry`
- [x] capabilities
- [x] tool-call budgets
- [x] execution timeouts
- [x] cancellation
- [x] lifecycle events

### Phase 2 — Isolated tools

- [ ] tool RPC over `TinypoolChannel`
- [ ] request / response correlation
- [ ] per-tool timeout
- [ ] per-tool concurrency limits
- [ ] structured tool errors
- [ ] audit hooks

### Phase 3 — Agent sessions

- [ ] persistent agent identity
- [ ] scoped session state
- [ ] session lifecycle hooks
- [ ] worker affinity options
- [ ] explicit session teardown

### Phase 4 — Runtime adapters

- [ ] stronger `child_process` policies
- [ ] container runtime adapter
- [ ] remote worker adapter
- [ ] scheduling priorities
- [ ] sub-agent execution

More detailed design notes live in [`docs/agent-runtime.md`](./docs/agent-runtime.md).

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

The package currently targets:

```text
Node.js ^20.0.0 || >=22.0.0
ESM
TypeScript
```

## Fork policy

This repository is intentionally allowed to diverge from upstream Tinypool.

Upstream fixes and useful worker-pool improvements can still be incorporated, but agent-specific features are developed for this fork rather than with the expectation that they will be merged into `tinylibs/tinypool`.

Where possible, agent functionality will remain modular so upstream synchronization stays manageable.

## Credits

This project is built on [Tinypool](https://github.com/tinylibs/tinypool), which originated as a smaller fork of [Piscina](https://github.com/piscinajs/piscina).

The original Tinypool and Piscina contributors remain the foundation of the worker-pool implementation.

## License

MIT. See [`LICENSE`](./LICENSE).
