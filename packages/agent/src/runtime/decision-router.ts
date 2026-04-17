import type { CanonicalFinishReason, CanonicalToolCall, CanonicalUsage } from "@renx/provider";
import type { RuntimeOutcome } from "../model/runtime";

export type AgentDecision =
  | {
      type: "final_answer";
      finishReason: CanonicalFinishReason;
      assistantText: string;
      usage?: CanonicalUsage;
      toolCalls: CanonicalToolCall[];
    }
  | {
      type: "tool_calls";
      finishReason: CanonicalFinishReason;
      assistantText: string;
      usage?: CanonicalUsage;
      toolCalls: CanonicalToolCall[];
    }
  | {
      type: "error";
      finishReason: CanonicalFinishReason;
      error: unknown;
      usage?: CanonicalUsage;
    };

export type DecisionRouterInput = {
  outcome: RuntimeOutcome;
  finishReason: CanonicalFinishReason;
  assistantText: string;
  toolCalls: CanonicalToolCall[];
  usage?: CanonicalUsage;
};

export class DecisionRouter {
  route(input: DecisionRouterInput): AgentDecision {
    if (!input.outcome.ok) {
      return {
        type: "error",
        finishReason: input.finishReason,
        error: input.outcome.error,
        usage: input.usage,
      };
    }

    if (input.finishReason === "tool_calls" && input.toolCalls.length > 0) {
      return {
        type: "tool_calls",
        finishReason: input.finishReason,
        assistantText: input.assistantText,
        usage: input.usage,
        toolCalls: input.toolCalls,
      };
    }

    return {
      type: "final_answer",
      finishReason: input.finishReason,
      assistantText: input.assistantText,
      usage: input.usage,
      toolCalls: input.toolCalls,
    };
  }
}
