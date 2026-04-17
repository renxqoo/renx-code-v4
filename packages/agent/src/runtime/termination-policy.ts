import type { QueryModelOutcome } from "../agent/types";
import type { AgentDecision } from "./decision-router";

export type TerminationEvaluation =
  | { shouldStop: false; reason: "continue" }
  | { shouldStop: true; reason: "success" | "error" | "max_steps"; error?: unknown };

export type TerminationPolicyInput = {
  llmRounds: number;
  maxSteps: number;
  decision: AgentDecision;
};

export interface TerminationPolicy {
  evaluate(input: TerminationPolicyInput): TerminationEvaluation;
  finalStopReason(outcome: QueryModelOutcome): string;
}

export class DefaultTerminationPolicy implements TerminationPolicy {
  evaluate(input: TerminationPolicyInput): TerminationEvaluation {
    if (input.decision.type === "error") {
      return { shouldStop: true, reason: "error", error: input.decision.error };
    }

    if (input.decision.type === "final_answer") {
      return { shouldStop: true, reason: "success" };
    }

    if (input.llmRounds >= input.maxSteps) {
      return {
        shouldStop: true,
        reason: "max_steps",
        error: new Error(`maxSteps (${input.maxSteps}) exceeded`),
      };
    }

    return { shouldStop: false, reason: "continue" };
  }

  finalStopReason(outcome: QueryModelOutcome): string {
    if (outcome.error) return "error";
    if (outcome.stopped) return outcome.stopReason ?? "stopped";
    return outcome.finishReason;
  }
}
