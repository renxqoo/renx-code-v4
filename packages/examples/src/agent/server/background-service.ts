import { AgentRuntime, createDefaultSandboxRegistry, InMemorySessionStore } from "@renx/agent";
import type { AgentHook, AgentRuntimeEvent, AgentRunRecord, ResumeRunInput } from "@renx/agent";
import type {
  CanonicalStreamChunk,
  CanonicalToolCall,
  LLMClient,
  StreamTextOptions,
  StreamTextResult,
} from "@renx/provider";
import { Agent } from "@renx/agent";
import { z } from "zod";
import { InMemoryRunQueue } from "./in-memory-run-queue";

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

function createDeterministicBackgroundClient(): LLMClient {
  const unsupported = async () => {
    throw new Error("This background demo client only implements streamText().");
  };

  const streamTextImpl = async (options: StreamTextOptions): Promise<StreamTextResult> => {
    const messages = options.messages ?? [];
    const userText = messages
      .flatMap((message) =>
        message.content
          .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
          .map((part) => part.text),
      )
      .join(" ")
      .toLowerCase();
    const hasToolResult = messages.some((message) => message.role === "tool");

    if (!hasToolResult && userText.includes("approval")) {
      const toolCalls: CanonicalToolCall[] = [
        {
          id: "call-send-email",
          name: "send_email",
          arguments:
            '{"to":"ceo@example.com","subject":"Incident resolved","body":"The incident is mitigated and the service is healthy."}',
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

    if (!hasToolResult && userText.includes("lookup")) {
      const toolCalls: CanonicalToolCall[] = [
        {
          id: "call-lookup-customer",
          name: "lookup_customer",
          arguments: '{"email":"alice@example.com"}',
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

    const finalText = hasToolResult
      ? "Background workflow completed successfully after tool execution."
      : "Background workflow completed without needing tools.";

    return {
      textStream: streamText(finalText, 150),
      text: Promise.resolve(finalText),
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

function createServiceRegistry() {
  const registry = new Agent({ maxSteps: 1 }).getToolRegistry();
  const lookupSchema = z.object({ email: z.string().email() });
  const emailSchema = z.object({
    to: z.string().email(),
    subject: z.string(),
    body: z.string(),
  });

  registry.register({
    id: "lookup_customer",
    name: "lookup_customer",
    description: "Look up a customer record in the CRM.",
    type: "read_only",
    schema: lookupSchema,
    execute: async (args) => {
      const parsed = lookupSchema.parse(args);
      return {
        success: true,
        content: `Resolved CRM data for ${parsed.email}`,
        metadata: { customerId: "cust_bg_001", email: parsed.email },
      };
    },
  });

  registry.register({
    id: "send_email",
    name: "send_email",
    description: "Send an outbound email after operator approval.",
    type: "write_only",
    schema: emailSchema,
    execute: async (args) => {
      const parsed = emailSchema.parse(args);
      return {
        success: true,
        content: `Queued email "${parsed.subject}" to ${parsed.to}`,
        metadata: { delivered: true },
      };
    },
  });

  return registry;
}

export type CreateBackgroundRunInput = {
  prompt: string;
};

export class BackgroundAgentService {
  readonly queue = new InMemoryRunQueue();
  readonly sessionStore = new InMemorySessionStore();
  private readonly approvedRuns = new Set<string>();
  private readonly runtime: AgentRuntime;
  private workerRunning = false;

  constructor() {
    const approvalHook: AgentHook = {
      name: "background-approval",
      authorizeTools: async (ctx) => {
        if (!ctx.invocations.some((invocation) => invocation.name === "send_email")) {
          return { action: "allow" };
        }
        if (this.approvedRuns.has(ctx.runId)) {
          this.approvedRuns.delete(ctx.runId);
          return { action: "allow" };
        }
        return {
          action: "pause",
          reason: "Awaiting operator approval.",
        };
      },
    };

    this.runtime = new AgentRuntime({
      maxSteps: 8,
      registry: createServiceRegistry(),
      sandboxRegistry: createDefaultSandboxRegistry(),
      llmClient: createDeterministicBackgroundClient(),
      sessionStore: this.sessionStore,
      hooks: [approvalHook],
    });
  }

  async createRun(input: CreateBackgroundRunInput): Promise<AgentRunRecord> {
    const run = await this.runtime.createRun({
      model: "demo/background-service",
      systemPrompt: "You are a managed background agent service.",
      messages: [{ role: "user", content: [{ type: "text", text: input.prompt }] }],
      toolChoice: "auto",
      temperature: 0,
    });
    this.queue.enqueue(run.runId);
    return run;
  }

  async getRun(runId: string): Promise<AgentRunRecord | null> {
    return this.runtime.getRun(runId);
  }

  async getTrace(runId: string): Promise<AgentRuntimeEvent[]> {
    return this.runtime.getRunTrace(runId);
  }

  async approveAndResume(runId: string, _input: ResumeRunInput = {}): Promise<void> {
    this.approvedRuns.add(runId);
    this.queue.enqueue(runId);
  }

  async cancel(runId: string): Promise<AgentRunRecord> {
    return this.runtime.cancelRun(runId);
  }

  async runWorkerLoop(signal: AbortSignal): Promise<void> {
    if (this.workerRunning) return;
    this.workerRunning = true;

    while (!signal.aborted) {
      const runId = await this.queue.dequeue(50, signal);
      if (!runId || signal.aborted) continue;

      const run = await this.runtime.getRun(runId);
      if (!run) continue;

      if (run.status === "cancelled" || run.status === "finished" || run.status === "failed") {
        continue;
      }

      if (run.status === "waiting_permission") {
        if (this.approvedRuns.has(runId)) {
          await this.runtime.resumeRun(runId, { clearPendingApproval: true });
        }
        continue;
      }

      if (run.status === "waiting_input") {
        continue;
      }

      if (run.status === "ready") {
        await this.runtime.startRun(runId);
        continue;
      }

      await this.runtime.resumeRun(runId);
    }

    this.workerRunning = false;
  }
}
