import type { CanonicalFinishReason, CanonicalStreamChunk, CanonicalTool } from "@renx/provider";
import type { QueryModelType } from "./type";
import {
  appendAssistantTextOnly,
  appendAssistantToolRound,
  appendToolResultMessages,
} from "./tool-messages";
import { runtime, type RuntimeOutcome } from "./runtime";
import { ToolRegistry } from "./tool/registry";
import { toolsToCanonical } from "./tool/canonical";
import { parseToolCallArguments } from "./tool/parse-args";
import { toolExecutor } from "./tool/tool-executor";
import type { Message } from "./message";

export type AgentConstructorConfig = {
  maxSteps: number;
  registry?: ToolRegistry;
};

export type QueryModelOutcome = {
  messages: Message[];
  finishReason: CanonicalFinishReason;
  llmRounds: number;
  lastStream: RuntimeOutcome;
  error?: unknown;
};

export type QueryModelHooks = {
  /** 每轮 LLM 消费 `textStream` 时触发；多轮工具循环下每一轮都会回调。 */
  onStreamChunk?: (chunk: CanonicalStreamChunk) => void | Promise<void>;
};

/**
 * `streamText` 的 `text` / `finishReason` / `toolCalls` 等 Promise 由内部 async generator 在消费 `textStream` 时推进；
 * 若不迭代 `textStream`，这些 Promise 不会 resolve。Agent 在读取字段前必须先排空流。
 */
async function drainTextStream(
  stream: AsyncIterable<CanonicalStreamChunk>,
  onChunk?: QueryModelHooks["onStreamChunk"],
): Promise<void> {
  for await (const chunk of stream) {
    if (onChunk) {
      await Promise.resolve(onChunk(chunk));
    }
  }
}

function mergeCanonicalTools(registryTools: CanonicalTool[], extra?: CanonicalTool[]): CanonicalTool[] | undefined {
  const byName = new Map<string, CanonicalTool>();
  for (const t of extra ?? []) {
    byName.set(t.name, t);
  }
  for (const t of registryTools) {
    byName.set(t.name, t);
  }
  const merged = [...byName.values()];
  return merged.length > 0 ? merged : undefined;
}

export class Agent {
  protected readonly config: { maxSteps: number };
  private readonly registry: ToolRegistry;

  constructor(config: AgentConstructorConfig) {
    this.config = { maxSteps: config.maxSteps };
    this.registry = config.registry ?? new ToolRegistry();
  }

  getToolRegistry(): ToolRegistry {
    return this.registry;
  }

  async queryModel(initial: QueryModelType, hooks?: QueryModelHooks): Promise<QueryModelOutcome> {
    const messages: Message[] = [...initial.messages];
    let llmRounds = 0;
    let lastStream: RuntimeOutcome = {
      ok: false,
      error: new Error("No LLM call was made"),
      textStream: (async function* () {})(),
      text: Promise.resolve(""),
      reasoning: Promise.resolve(""),
      toolCalls: Promise.resolve([]),
      usage: Promise.resolve(undefined),
      finishReason: Promise.resolve("error"),
    };

    while (true) {
      if (llmRounds >= this.config.maxSteps) {
        const finishReason = await lastStream.finishReason;
        return {
          messages,
          finishReason,
          llmRounds,
          lastStream,
          error: new Error(`maxSteps (${this.config.maxSteps}) exceeded`),
        };
      }
      llmRounds++;
      const registryCanonical = toolsToCanonical(this.registry.list());
      const tools = mergeCanonicalTools(registryCanonical, initial.tools);

      const streamConfig: QueryModelType = {
        ...initial,
        messages,
        ...(tools ? { tools } : {}),
        toolChoice: initial.toolChoice,
      };

      const outcome = await runtime(streamConfig);
      lastStream = outcome;

      await drainTextStream(outcome.textStream, hooks?.onStreamChunk);

      const finishReason = await outcome.finishReason;
      const assistantText = await outcome.text;
      const calls = await outcome.toolCalls;

      if (!outcome.ok) {
        return {
          messages,
          finishReason,
          llmRounds,
          lastStream: outcome,
          error: outcome.error,
        };
      }

      if (finishReason !== "tool_calls" || calls.length === 0) {
        appendAssistantTextOnly(messages, assistantText);
        return {
          messages,
          finishReason,
          llmRounds,
          lastStream: outcome,
        };
      }

      appendAssistantToolRound(messages, assistantText, calls);

      const invocations = calls.map((call) => {
        const tool = this.registry.get(call.name);
        if (!tool) {
          throw new Error(`Tool not registered: ${call.name}`);
        }
        return {
          tool,
          args: parseToolCallArguments(call.arguments),
          callId: call.id,
        };
      });

      const results = await toolExecutor(invocations);
      appendToolResultMessages(messages, calls, results);
    }
  }
}
