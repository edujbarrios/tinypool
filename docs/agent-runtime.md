# Agent runtime architecture

This document describes the direction of the agent-oriented layer in this fork.

The core principle is to keep Tinypool responsible for what it already does well — scheduling and executing work — while agent-specific concerns live in a higher-level runtime.

## Layers

```text
Application / Agent Framework
          │
          ▼
      Agent Runtime
          │
   ┌──────┼───────────────┐
   │      │               │
 Identity Limits      Tool policy
   │      │               │
   └──────┴───────┬───────┘
                  ▼
              Tinypool
                  │
       ┌──────────┴──────────┐
       ▼                     ▼
worker_threads          child_process
```

## Responsibilities

### Tinypool core

The existing Tinypool layer remains responsible for:

- worker creation and reuse
- task scheduling
- queue management
- runtime selection
- cancellation
- worker recycling
- memory-based recycling
- parent ↔ worker communication

### Agent runtime

The agent layer adds:

- stable agent identity
- serializable execution envelopes
- explicit capabilities
- a tool registry
- tool-call budgets
- wall-clock execution timeout
- lifecycle events
- future tool RPC
- future session state

## Why tools should stay in the parent process

A worker running an LLM or agent loop should not automatically receive privileged functions.

Passing executable tool implementations into a worker creates several problems:

- functions are not naturally serializable
- privileged credentials can leak into less trusted execution contexts
- authorization logic becomes distributed
- auditing becomes harder
- retries and timeouts become inconsistent

Instead, the target model is request/response RPC.

```text
worker
  │
  │  tool.request
  │  { name, input, agentId, callId }
  ▼
parent
  │
  ├─ validate agent identity
  ├─ validate capability
  ├─ validate tool policy
  ├─ execute tool
  ├─ emit audit events
  └─ serialize result
  │
  │  tool.response
  ▼
worker
```

The existing `TinypoolChannel` is the intended transport for this layer.

## Capability model

Capabilities are authorization labels.

Examples:

```text
filesystem.read
filesystem.write
github.read
github.write
network.http
shell.execute
```

A tool declares the capabilities required to execute.

An agent context declares the capabilities granted to that agent.

Authorization succeeds only when all required capabilities are present.

Capabilities are intentionally simple strings for now. A future policy layer may support resource-scoped permissions such as:

```text
filesystem.read:/workspace/**
github.write:owner/repository
network.http:api.example.com
```

## Isolation model

Capabilities do not provide process isolation.

The runtime boundary determines isolation strength:

### `worker_threads`

Best for:

- CPU-heavy tasks
- trusted code
- lower overhead
- shared-process workloads

Tradeoff:

- workers share the same process-level trust boundary

### `child_process`

Best for:

- stronger isolation from the parent process
- agents running less trusted application code
- separate memory space

Tradeoff:

- higher startup and IPC overhead

### Future runtimes

Potential adapters:

- container runtime
- remote worker runtime
- sandbox service
- WASI / WebAssembly runtime

These should implement the same execution contract instead of changing the agent API.

## Tool RPC protocol direction

A first version can use a small message protocol.

Request:

```ts
interface ToolRequest {
  type: 'agent:tool:request'
  callId: string
  agentId: string
  tool: string
  input: unknown
}
```

Response:

```ts
interface ToolResponse {
  type: 'agent:tool:response'
  callId: string
  result?: unknown
  error?: {
    name: string
    message: string
  }
}
```

The protocol should remain transport-independent so the same model can later work over child-process IPC, worker-thread ports, sockets or remote transports.

## Limits

The runtime currently models:

- maximum tool calls per context
- execution timeout
- external cancellation

Future limits should include:

- per-tool timeout
- per-tool concurrency
- maximum concurrent agents
- maximum serialized result size
- maximum session lifetime
- request rate limits

## Lifecycle events

Current events:

```text
agent:start
agent:finish
agent:error
```

Future events may include:

```text
agent:tool:start
agent:tool:finish
agent:tool:error
agent:cancel
agent:timeout
agent:session:start
agent:session:end
```

These events should be sufficient to build tracing integrations without coupling the runtime to a specific observability SDK.

## Non-goals

This project should not become:

- an LLM provider SDK
- a prompt-management framework
- a vector database abstraction
- a graph workflow DSL
- a replacement for application-level agent frameworks

Those systems should be able to use this runtime underneath them.

## Compatibility strategy

Agent-specific APIs should stay under the `tinypool/agent` export where possible.

That keeps:

```ts
import Tinypool from 'tinypool'
```

compatible with the original worker-pool use case while allowing:

```ts
import { AgentPool } from 'tinypool/agent'
```

to evolve more aggressively.

## Next implementation milestone

The next meaningful implementation step is parent ↔ worker tool RPC using `TinypoolChannel`.

That unlocks:

- privileged tools outside the worker
- capability enforcement at the parent boundary
- structured tool lifecycle events
- better auditing
- future remote workers
