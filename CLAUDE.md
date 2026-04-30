# Claude.md for renx-code-v4

## Project Overview

**renx-code-v4** is a TypeScript monorepo building an AI agent SDK ecosystem. It provides LLM provider abstraction, a functional agent runtime, and persistence/worker infrastructure.

- **Package Manager**: pnpm@10.13.1 (workspaces)
- **Language**: TypeScript 5.8, ES2022 target, NodeNext module system
- **Lint/Format**: oxlint + oxfmt
- **Testing**: vitest

## Monorepo Packages

### `@renx/provider` (packages/provider)
The LLM abstraction layer. Self-contained (no external deps). Provides:
- `CanonicalMessage`, `CanonicalStreamChunk`, `CanonicalTool` types
- `LLMClient` interface with `generateText`, `streamText`, `generateImage`, etc.
- Adapter pattern for vendors: `createOpenAIAdapter`, `createAnthropicAdapter`, `createMinimaxAdapter`, `createEchoAdapter`
- Top-level convenience functions: `generateText()`, `streamText()`, `createLLMClient()`, `createDefaultLLMClient()`
- Export paths: `.` (main), `./llm` (subpath)

### `@renx/agent-v2` (packages/agent-v2) — **Current SDK**
The primary agent SDK. Functional, event-streaming architecture. Export paths:

| Export Path | Contents |
|---|---|
| `.` | Core: `agent()`, `RunState`, `AgentEvent`, types |
| `./plugins` | 11 plugins via `pipe()` composition |
| `./multi-agent` | `agentAsTool()`, `handoff()` |
| `./runner` | `RunManager`, `createWorker` |
| `./adapters` | Persistence: InMemory, FileSystem, Postgres |
| `./telemetry` | OpenTelemetry + Console sinks |
| `./providers` | `createProviderBridge()` for `@renx/provider` |

### `@renx/agent` (packages/agent) — **DEPRECATED**
The older enterprise agent SDK. Do NOT use for new work. It includes CubeSandbox (E2B), session stores, MCP integration, runtime engine. Agent-v2 is the replacement.

### `@renx/examples` (packages/examples)
8 demo scripts under `src/agent-v2/` (01 through 08) demonstrating the full agent-v2 feature surface.

## Architecture

```
@renx/provider          @renx/agent-v2
(LLM abstraction)       (Agent runtime)
        │                      │
        │    createProviderBridge()
        └──────────────────────┤
                               │
                    ┌──────────┴──────────┐
                    │  agent() generator  │
                    │  + pipe() plugins   │
                    │  + multi-agent      │
                    │  + runner/worker    │
                    └─────────────────────┘
```

### Agent Loop (ReAct pattern)
`agent()` is an **async generator** that yields `AgentEvent` objects:
1. **LLM Stream** — streams tokens/tool calls from LLM
2. **Decision** — `onTools` injection for approval/deny
3. **Execute Tools** — parallel or sequential execution
4. Repeat until `maxSteps` or stop condition

### Plugin System
Plugins are **higher-order functions**: `Plugin = (inner: AgentFn) => AgentFn`

Compose with `pipe()` (left-to-right wrapping):
```typescript
pipe(
  withLogging(logger),           // outermost wrapper
  withRetry({ maxRetries: 3 }),
  agent                          // core function
)
```

Two plugin categories:
- **Event Observer**: wraps the generator to observe/modify events (logging, retry, timeout, cache, telemetry, max-tokens)
- **Input Injector**: modifies `AgentInput` before delegation (approval, sandbox, conversation-history)

### Runner / Worker
- `RunManager` — create/resume/stream/pause/cancel lifecycle
- `createWorker()` — background polling with lease-based distributed execution
- Worker lease protocol: acquire → stream → renew lease → complete/release

### Multi-Agent
- `agentAsTool(childAgent)` — wrap a child agent as a Tool the parent can call
- `handoff(targetName)` — creates a Tool that throws `HandoffSignal` to transfer control

---

## Key Files (agent-v2)

| File | Purpose |
|---|---|
| `src/agent.ts` | Core `agent()` async generator (ReAct loop) |
| `src/state.ts` | `RunState` type and `initState()` |
| `src/message.ts` | Message types + constructors |
| `src/tool.ts` | `Tool<I,O>` type with zod schema |
| `src/events.ts` | 14 event types: `AgentEvent` union |
| `src/errors.ts` | Error codes + `AgentError` type |
| `src/plugin.ts` | Plugin type + `pipe()` composer |
| `src/plugins/` | 11 plugin implementations |
| `src/multi-agent/` | agent-as-tool + handoff |
| `src/runner/manager.ts` | `RunManager` (singleton) |
| `src/runner/worker.ts` | `createWorker()` background processor |
| `src/runner/adapters/` | PersistenceAdapter interface + 3 impls |
| `src/providers/index.ts` | Provider bridge to @renx/provider |

---

## Development Commands

```bash
pnpm build          # Build all packages (provider first, then agent + agent-v2)
pnpm test           # Run all tests (vitest)
pnpm test:watch     # Watch mode
pnpm lint           # Lint with oxlint
pnpm lint:fix       # Auto-fix lint issues
pnpm format         # Format with oxfmt
pnpm typecheck      # TypeScript type checking (tsc -b)
```

Run a specific example:
```bash
pnpm --filter @renx/examples demo:01-basic
```

---

## Patterns & Conventions

### Creating a Plugin
```typescript
export function myPlugin(options: MyPluginOptions): Plugin {
  return (inner) => {
    // Return a new AgentFn (may modify input, wrap generator, or both)
    return async function* (input: AgentInput): AgentGenerator {
      // Pre-processing: modify input
      // Delegate to inner
      // Post-processing: modify streamed events
    };
  };
}
```

### Event Streaming
Always iterate events and handle by `event.type`:
```typescript
for await (const event of agent(input)) {
  switch (event.type) {
    case "llm:delta":       console.write(event.delta);
    case "run:finished":    console.log(event.result);
  }
}
```

### Provider Setup
```typescript
import { createDefaultLLMClient } from "@renx/provider";
import { createProviderBridge, setDefaultLLMClient } from "@renx/provider";
setDefaultLLMClient(createProviderBridge(createDefaultLLMClient({ vendors: ["minimax"] })));
```

### Tools Use Zod for Schema
```typescript
import { z } from "zod";
const myTool: Tool = {
  name: "my_tool",
  description: "Does something",
  parameters: z.object({ query: z.string() }),
  execute: async (input, ctx) => { /* ... */ }
};
```

---

## Deprecation Note

The `packages/agent` directory contains the **deprecated** enterprise agent SDK. All new development should use `packages/agent-v2`. Do not modify or add features to `packages/agent`.

---

## Important Constraints

1. **No emojis** in code, comments, or output unless explicitly requested
2. **No comments** unless logic is genuinely non-obvious
3. **No defensive programming** for impossible states — trust internal code guarantees
4. **No premature abstraction** — prefer three similar lines over a bad abstraction
5. **Tests required** for new functionality (vitest, co-located: `foo.test.ts` next to `foo.ts`)
6. **Build order matters**: provider must build before agent-v2 (compiled ts project references handle this)
