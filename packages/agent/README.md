# @renx/agent

Managed agent runtime primitives for long-running, resumable workflows.

## Enterprise-oriented capabilities

- Durable session storage via `FileSessionStore`
- Database-backed durable storage via `PostgresSessionStore`
- Event replay via `getRunTrace(runId, { offset, limit })`
- Worker coordination via run leases
- Remote tool execution via `HttpSandboxBackend`
- Containerized tool execution via `DockerSandboxBackend`
- Lifecycle audit hooks and telemetry sinks
- OpenTelemetry integration via `OpenTelemetrySink`
- MCP tool adaptation via `createMcpTool()`

## Basic example

```ts
import {
  Agent,
  FileSessionStore,
  HttpSandboxBackend,
  OpenTelemetrySink,
  createDefaultSandboxRegistry,
} from "@renx/agent";

const sandboxRegistry = createDefaultSandboxRegistry().register(
  "remote",
  new HttpSandboxBackend({
    endpoint: "https://sandbox.example/execute",
  }),
);

const agent = new Agent({
  maxSteps: 8,
  sessionStore: new FileSessionStore({ directory: ".agent-state" }),
  sandboxRegistry,
  telemetry: new OpenTelemetrySink(),
});

const worker = agent.createWorker({
  ownerId: "worker-1",
  leaseTtlMs: 30000,
});
```

## Worker model

`AgentWorker` scans runs, acquires a lease, and then:

- starts `ready` runs
- resumes `running` runs
- skips `waiting_permission` and `waiting_input` by default

You can override this behavior with `decide(run)`.

## Optional production primitives

### Postgres store

```ts
import { Pool } from "pg";
import { PostgresSessionStore } from "@renx/agent";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = new PostgresSessionStore({ db: pool });
await store.init();
```

### Docker sandbox

```ts
import { DockerSandboxBackend, createDefaultSandboxRegistry } from "@renx/agent";

const sandboxRegistry = createDefaultSandboxRegistry().register(
  "docker_default",
  new DockerSandboxBackend({
    image: "ghcr.io/acme/agent-sandbox:latest",
    containerCommand: ["node", "/app/runner.js"],
  }),
);
```

### MCP tools

```ts
import { createMcpTool } from "@renx/agent";
import { z } from "zod";

const tool = createMcpTool({
  id: "crm_lookup",
  name: "lookup_customer",
  type: "read_only",
  schema: z.object({ email: z.string().email() }),
  client: mcpClient,
  server: "crm-mcp",
});
```
