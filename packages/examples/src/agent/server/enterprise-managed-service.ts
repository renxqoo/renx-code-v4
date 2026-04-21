import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  AgentRuntime,
  AgentWorker,
  FileSessionStore,
  HttpSandboxBackend,
  OpenTelemetrySink,
  ToolRegistry,
  createDefaultSandboxRegistry,
  createMcpTool,
} from "@renx/agent";
import type {
  AgentHook,
  AgentRuntimeEvent,
  AgentRunRecord,
  AgentTelemetryEvent,
  AgentTelemetrySink,
  McpToolClient,
} from "@renx/agent";
import type {
  CanonicalStreamChunk,
  CanonicalToolCall,
  LLMClient,
  StreamTextOptions,
  StreamTextResult,
} from "@renx/provider";
import { z } from "zod";
import { startEnterpriseSandboxServer, type EnterpriseSandboxServer } from "./enterprise-sandbox-server";

type CreateManagedRunInput = {
  prompt: string;
};

type EnterpriseManagedDemoServiceOptions = {
  stateDirectory?: string;
};

type CustomerRecord = {
  email: string;
  name: string;
  plan: string;
};

class MemoryTelemetrySink implements AgentTelemetrySink {
  readonly events: AgentTelemetryEvent[] = [];

  capture(event: AgentTelemetryEvent): void {
    this.events.push(event);
  }
}

class FanoutTelemetrySink implements AgentTelemetrySink {
  constructor(private readonly sinks: AgentTelemetrySink[]) {}

  async capture(event: AgentTelemetryEvent): Promise<void> {
    for (const sink of this.sinks) {
      await sink.capture(event);
    }
  }
}

class FakeCrmMcpClient implements McpToolClient {
  private readonly records = new Map<string, CustomerRecord>([
    ["alice@example.com", { email: "alice@example.com", name: "Alice", plan: "enterprise" }],
    ["bob@example.com", { email: "bob@example.com", name: "Bob", plan: "pro" }],
  ]);

  async callTool<TArgs extends Record<string, unknown>>(request: {
    server: string;
    toolName: string;
    arguments: TArgs;
  }): Promise<{ content: string; metadata?: Record<string, unknown>; success?: boolean }> {
    const email = String(request.arguments.email ?? "alice@example.com").toLowerCase();
    const record = this.records.get(email) ?? { email, name: "Unknown", plan: "trial" };
    return {
      success: true,
      content: `Resolved CRM data for ${record.email}: ${record.name} (${record.plan}).`,
      metadata: record,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function* streamText(text: string, delayMs = 0): AsyncGenerator<CanonicalStreamChunk> {
  if (delayMs > 0) {
    await sleep(delayMs);
  }
  yield { type: "text-delta", textDelta: text };
  yield { type: "finish", finishReason: "stop" };
}

async function* streamToolCalls(toolCalls: CanonicalToolCall[]): AsyncGenerator<CanonicalStreamChunk> {
  for (const [index, call] of toolCalls.entries()) {
    yield {
      type: "tool-call-delta",
      index,
      id: call.id,
      name: call.name,
      argumentsDelta: call.arguments,
    };
  }
  yield { type: "finish", finishReason: "tool_calls" };
}

function collectText(messages: StreamTextOptions["messages"] = []): string {
  return messages
    .flatMap((message) =>
      message.content
        .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
        .map((part) => part.text),
    )
    .join(" ")
    .toLowerCase();
}

function collectToolResultTexts(messages: StreamTextOptions["messages"] = []): string[] {
  return messages
    .filter((message) => message.role === "tool")
    .flatMap((message) =>
      message.content
        .filter(
          (part): part is Extract<(typeof message.content)[number], { type: "tool_result" }> =>
            part.type === "tool_result",
        )
        .map((part) => part.content.toLowerCase()),
    );
}

function extractEmail(text: string): string {
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0]?.toLowerCase() ?? "alice@example.com";
}

function createDeterministicEnterpriseClient(): LLMClient {
  const unsupported = async () => {
    throw new Error("This enterprise managed demo client only implements streamText().");
  };

  const streamTextImpl = async (options: StreamTextOptions): Promise<StreamTextResult> => {
    const prompt = collectText(options.messages);
    const toolResults = collectToolResultTexts(options.messages);
    const email = extractEmail(prompt);
    const needsLookup = prompt.includes("lookup");
    const needsNotification = prompt.includes("notify") || prompt.includes("email");
    const needsTicket = prompt.includes("incident") || prompt.includes("ticket");

    if (needsLookup && !toolResults.some((entry) => entry.includes("resolved crm data"))) {
      const toolCalls: CanonicalToolCall[] = [
        {
          id: "call-lookup-customer",
          name: "lookup_customer",
          arguments: JSON.stringify({ email }),
        },
      ];
      return {
        textStream: streamToolCalls(toolCalls),
        text: Promise.resolve(""),
        reasoning: Promise.resolve(""),
        toolCalls: Promise.resolve(toolCalls),
        usage: Promise.resolve(undefined),
        finishReason: Promise.resolve("tool_calls"),
      };
    }

    if (needsTicket && !toolResults.some((entry) => entry.includes("created incident ticket"))) {
      const toolCalls: CanonicalToolCall[] = [
        {
          id: "call-create-incident",
          name: "create_incident_ticket",
          arguments: JSON.stringify({
            title: "Customer-visible production incident",
            severity: "sev-2",
            summary: `Investigate customer issue reported for ${email}.`,
          }),
        },
      ];
      return {
        textStream: streamToolCalls(toolCalls),
        text: Promise.resolve(""),
        reasoning: Promise.resolve(""),
        toolCalls: Promise.resolve(toolCalls),
        usage: Promise.resolve(undefined),
        finishReason: Promise.resolve("tool_calls"),
      };
    }

    if (
      needsNotification &&
      toolResults.some((entry) => entry.includes("resolved crm data")) &&
      !toolResults.some((entry) => entry.includes('queued email "customer update"'))
    ) {
      const toolCalls: CanonicalToolCall[] = [
        {
          id: "call-send-email",
          name: "send_email",
          arguments: JSON.stringify({
            to: email,
            subject: "Customer update",
            body: "We have reviewed your case and opened the required follow-up workflow.",
          }),
        },
      ];
      return {
        textStream: streamToolCalls(toolCalls),
        text: Promise.resolve(""),
        reasoning: Promise.resolve(""),
        toolCalls: Promise.resolve(toolCalls),
        usage: Promise.resolve(undefined),
        finishReason: Promise.resolve("tool_calls"),
      };
    }

    const summary = toolResults.length > 0
      ? `Managed workflow complete. Evidence: ${toolResults.join(" | ")}`
      : "Managed workflow complete without tools.";

    return {
      textStream: streamText(summary, 120),
      text: Promise.resolve(summary),
      reasoning: Promise.resolve(""),
      toolCalls: Promise.resolve([]),
      usage: Promise.resolve(undefined),
      finishReason: Promise.resolve("stop"),
    };
  };

  return {
    generateText: unsupported,
    streamText: streamTextImpl,
    generateImage: unsupported,
    textToSpeech: unsupported,
    transcribe: unsupported,
    generateVideo: unsupported,
    getVideoJob: unsupported,
    downloadVideo: unsupported,
  } as LLMClient;
}

function createRemoteOnlyExecutor(toolName: string) {
  return async () => {
    throw new Error(`Tool ${toolName} must be executed by a configured sandbox backend.`);
  };
}

function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const crmClient = new FakeCrmMcpClient();

  registry.register(
    createMcpTool({
      id: "crm_lookup",
      name: "lookup_customer",
      description: "Look up a customer record via MCP-backed CRM access.",
      type: "read_only",
      schema: z.object({ email: z.string().email() }),
      client: crmClient,
      server: "crm-mcp",
      toolName: "lookup_customer_by_email",
    }),
  );

  registry.register({
    id: "send_email",
    name: "send_email",
    description: "Send a customer follow-up email via the remote sandbox.",
    type: "write_only",
    schema: z.object({
      to: z.string().email(),
      subject: z.string(),
      body: z.string(),
    }),
    sandboxProfileId: "remote_http",
    execute: createRemoteOnlyExecutor("send_email"),
  });

  registry.register({
    id: "create_incident_ticket",
    name: "create_incident_ticket",
    description: "Create an incident ticket via the remote sandbox.",
    type: "write_only",
    schema: z.object({
      title: z.string(),
      severity: z.string(),
      summary: z.string(),
    }),
    sandboxProfileId: "remote_http",
    execute: createRemoteOnlyExecutor("create_incident_ticket"),
  });

  return registry;
}

export class EnterpriseManagedDemoService {
  readonly sessionStore: FileSessionStore;
  readonly telemetry: MemoryTelemetrySink;
  readonly stateDirectory: string;
  readonly sandbox: EnterpriseSandboxServer;
  private readonly approvedRuns: Set<string>;
  private readonly runtime: AgentRuntime;
  private readonly worker: AgentWorker;

  private constructor(args: {
    stateDirectory: string;
    sandbox: EnterpriseSandboxServer;
    sessionStore: FileSessionStore;
    runtime: AgentRuntime;
    worker: AgentWorker;
    telemetry: MemoryTelemetrySink;
    approvedRuns: Set<string>;
  }) {
    this.stateDirectory = args.stateDirectory;
    this.sandbox = args.sandbox;
    this.sessionStore = args.sessionStore;
    this.runtime = args.runtime;
    this.worker = args.worker;
    this.telemetry = args.telemetry;
    this.approvedRuns = args.approvedRuns;
  }

  static async create(options: EnterpriseManagedDemoServiceOptions = {}): Promise<EnterpriseManagedDemoService> {
    const sandbox = await startEnterpriseSandboxServer();
    const stateDirectory = options.stateDirectory ?? join(process.cwd(), ".demo-state", "enterprise-managed-agent");
    await mkdir(stateDirectory, { recursive: true });

    const sessionStore = new FileSessionStore({ directory: stateDirectory });
    const telemetry = new MemoryTelemetrySink();
    const telemetrySink = new FanoutTelemetrySink([telemetry, new OpenTelemetrySink()]);
    const sandboxRegistry = createDefaultSandboxRegistry().register(
      "remote_http",
      new HttpSandboxBackend({ endpoint: sandbox.endpoint }),
    );

    const approvedRuns = new Set<string>();
    const approvalHook: AgentHook = {
      name: "enterprise-demo-approval",
      authorizeTools: async (ctx) => {
        const hasWrite = ctx.invocations.some((invocation) =>
          invocation.name === "send_email" || invocation.name === "create_incident_ticket",
        );
        if (!hasWrite) {
          return { action: "allow" };
        }
        if (approvedRuns.has(ctx.runId)) {
          approvedRuns.delete(ctx.runId);
          return { action: "allow" };
        }
        return {
          action: "pause",
          reason: "Awaiting operator approval for remote write tools.",
        };
      },
    };

    const runtime = new AgentRuntime({
      maxSteps: 8,
      registry: createRegistry(),
      sandboxRegistry,
      llmClient: createDeterministicEnterpriseClient(),
      sessionStore,
      hooks: [approvalHook],
      telemetry: telemetrySink,
    });

    const worker = new AgentWorker({
      runtime,
      ownerId: "enterprise-demo-worker",
      pollIntervalMs: 200,
      leaseTtlMs: 30_000,
      statuses: ["ready", "running", "waiting_permission"],
      decide: async (run) => {
        if (run.status === "ready") return { action: "start" };
        if (run.status === "running") return { action: "resume", input: {} };
        if (run.status === "waiting_permission") {
          if (approvedRuns.has(run.runId)) {
            return { action: "resume", input: { clearPendingApproval: true } };
          }
          return { action: "skip", reason: "Waiting for operator approval." };
        }
        return { action: "skip", reason: `Unsupported status ${run.status}` };
      },
      telemetry: telemetrySink,
    });

    const service = new EnterpriseManagedDemoService({
      stateDirectory,
      sandbox,
      sessionStore,
      runtime,
      worker,
      telemetry,
      approvedRuns,
    });
    return service;
  }

  async runWorkerLoop(signal: AbortSignal): Promise<void> {
    await this.worker.runLoop(signal);
  }

  async createRun(input: CreateManagedRunInput): Promise<AgentRunRecord> {
    return this.runtime.createRun({
      model: "demo/enterprise-managed-agent",
      systemPrompt:
        "You are an enterprise managed agent. Use lookup_customer for CRM lookups, create_incident_ticket for incidents, and send_email after approval.",
      messages: [{ role: "user", content: [{ type: "text", text: input.prompt }] }],
      toolChoice: "auto",
      temperature: 0,
    });
  }

  async listRuns(): Promise<AgentRunRecord[]> {
    return this.runtime.listRuns();
  }

  async getRun(runId: string): Promise<AgentRunRecord | null> {
    return this.runtime.getRun(runId);
  }

  async getTrace(runId: string, limit?: number): Promise<AgentRuntimeEvent[]> {
    return this.runtime.getRunTrace(runId, limit == null ? undefined : { offset: 0, limit });
  }

  getTelemetry(limit = 20): AgentTelemetryEvent[] {
    return this.telemetry.events.slice(-Math.max(0, limit));
  }

  approve(runId: string): void {
    this.approvedRuns.add(runId);
  }

  async close(): Promise<void> {
    await this.sandbox.close();
  }
}
