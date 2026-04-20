import { Agent, AgentRuntime, createDefaultSandboxRegistry } from "@renx/agent";
import type { AgentHook, AgentRuntimeEvent, AgentRunRecord } from "@renx/agent";
import { InMemorySessionStore } from "@renx/agent";
import type {
  CanonicalFinishReason,
  CanonicalStreamChunk,
  CanonicalToolCall,
  CanonicalUsage,
  LLMClient,
  StreamTextOptions,
  StreamTextResult,
} from "@renx/provider";
import { z } from "zod";

type FakeStep = {
  text?: string;
  toolCalls?: CanonicalToolCall[];
  finishReason?: CanonicalFinishReason;
  delayMs?: number;
  usage?: CanonicalUsage;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function* streamChunks(step: FakeStep): AsyncGenerator<CanonicalStreamChunk> {
  if (step.delayMs) {
    await sleep(step.delayMs);
  }
  if (step.text) {
    yield { type: "text-delta", textDelta: step.text };
  }
  if (step.toolCalls?.length) {
    for (const [index, call] of step.toolCalls.entries()) {
      yield {
        type: "tool-call-delta",
        index,
        id: call.id,
        name: call.name,
        argumentsDelta: call.arguments,
      };
    }
  }
  yield {
    type: "finish",
    finishReason: step.finishReason ?? (step.toolCalls?.length ? "tool_calls" : "stop"),
    usage: step.usage,
  };
}

function createStreamTextResult(step: FakeStep): StreamTextResult {
  const finishReason = step.finishReason ?? (step.toolCalls?.length ? "tool_calls" : "stop");
  return {
    textStream: streamChunks(step),
    text: Promise.resolve(step.text ?? ""),
    reasoning: Promise.resolve(""),
    toolCalls: Promise.resolve(step.toolCalls ?? []),
    usage: Promise.resolve(step.usage),
    finishReason: Promise.resolve(finishReason),
  };
}

export function createSequencedLLMClient(steps: FakeStep[]): LLMClient {
  let index = 0;
  const next = async (): Promise<StreamTextResult> => {
    const step = steps[index] ?? steps[steps.length - 1] ?? { text: "No response configured." };
    index += 1;
    return createStreamTextResult(step);
  };

  const unsupported = async () => {
    throw new Error("This fake demo client only implements streamText().");
  };

  return {
    generateText: unsupported,
    streamText: (_options: StreamTextOptions) => next(),
    generateImage: unsupported,
    textToSpeech: unsupported,
    transcribe: unsupported,
    generateVideo: unsupported,
    getVideoJob: unsupported,
    downloadVideo: unsupported,
  } as LLMClient;
}

export function createRuntimeDemoRegistry() {
  const registry = new Agent({ maxSteps: 1 }).getToolRegistry();
  const lookupCustomerSchema = z.object({ email: z.string().email() });
  const sendEmailSchema = z.object({
    to: z.string().email(),
    subject: z.string(),
    body: z.string(),
  });

  registry.register({
    id: "lookup_customer",
    name: "lookup_customer",
    description: "Look up a customer from the CRM.",
    type: "read_only",
    schema: lookupCustomerSchema,
    execute: async (args) => {
      const parsed = lookupCustomerSchema.parse(args);
      return {
      success: true,
      content: `Found customer record for ${parsed.email}`,
      metadata: { customerId: "cust_demo_001" },
      };
    },
  });
  registry.register({
    id: "send_email",
    name: "send_email",
    description: "Send an email that requires operator approval.",
    type: "write_only",
    schema: sendEmailSchema,
    execute: async (args) => {
      const parsed = sendEmailSchema.parse(args);
      return {
      success: true,
      content: `Sent "${parsed.subject}" to ${parsed.to}`,
      metadata: { delivered: true },
      };
    },
  });
  return registry;
}

export function createRuntimeDemoRequest(text: string): Parameters<AgentRuntime["createRun"]>[0] {
  return {
    model: "demo/fake-runtime",
    systemPrompt: "You are an enterprise managed agent demo.",
    messages: [{ role: "user", content: [{ type: "text", text }] }],
    toolChoice: "auto",
    temperature: 0,
  };
}

export function createFakeRuntime(options: {
  steps: FakeStep[];
  hooks?: AgentHook[];
  maxSteps?: number;
  sessionStore?: InMemorySessionStore;
}) {
  const sessionStore = options.sessionStore ?? new InMemorySessionStore();
  return {
    sessionStore,
    runtime: new AgentRuntime({
      maxSteps: options.maxSteps ?? 6,
      registry: createRuntimeDemoRegistry(),
      sandboxRegistry: createDefaultSandboxRegistry(),
      llmClient: createSequencedLLMClient(options.steps),
      hooks: options.hooks,
      sessionStore,
    }),
  };
}

export function printRunRecord(run: AgentRunRecord | null) {
  if (!run) {
    console.log("Run not found.");
    return;
  }

  console.log({
    runId: run.runId,
    status: run.status,
    llmRounds: run.llmRounds,
    stopReason: run.stopReason,
    pendingApproval: run.pendingApproval?.invocations.map((invocation) => invocation.name),
    summaryId: run.summary?.summaryId,
  });
}

export function printTrace(events: AgentRuntimeEvent[]) {
  console.log(events.map((event) => event.type));
}
