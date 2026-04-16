import type { Message } from "../domain/message";
import type { QueryModelType } from "../domain/query-model";
import { runtime, type RuntimeOutcome } from "../model/runtime";
import { drainTextStream } from "../model/stream-drain";
import {
  appendAssistantTextOnly,
  appendAssistantToolRound,
  appendToolResultMessages,
} from "../conversation/tool-messages";
import { toolsToCanonical } from "../tools/canonical";
import { parseToolCallArguments } from "../tools/parse-args";
import type { ToolRegistry } from "../tools/registry";
import { toolExecutor } from "../tools/tool-executor";
import { mergeCanonicalTools } from "./merge-tools";
import type { QueryModelHooks, QueryModelOutcome } from "./types";

export type RunQueryModelLoopParams = {
  initial: QueryModelType;
  maxSteps: number;
  registry: ToolRegistry;
  hooks?: QueryModelHooks;
};

/**
 * ReAct 风格多轮：单次 LLM → 排空流 → 若非 tool_calls 则结束，否则执行工具并写回 messages 后继续。
 * 与具体 `Agent` 类解耦，便于后续替换为 Harness / ReActLoopEngine 实现而不改调用方测试。
 */
export async function runQueryModelLoop(params: RunQueryModelLoopParams): Promise<QueryModelOutcome> {
  const { initial, maxSteps, registry, hooks } = params;
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
    if (llmRounds >= maxSteps) {
      const finishReason = await lastStream.finishReason;
      return {
        messages,
        finishReason,
        llmRounds,
        lastStream,
        error: new Error(`maxSteps (${maxSteps}) exceeded`),
      };
    }
    llmRounds++;
    const registryCanonical = toolsToCanonical(registry.list());
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
      const tool = registry.get(call.name);
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
