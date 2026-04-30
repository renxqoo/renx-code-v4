import type { Plugin } from "../plugin.js";
import type { AgentInput } from "../types.js";
import type { AgentGenerator } from "../types.js";

/**
 * Max tokens plugin — limits cumulative token usage.
 *
 * Monitors tokenUsage from llm:done events.
 * Behavior when maxTotalTokens is reached:
 * - "warn": injects a warning message (Phase 2+) but continues
 * - "stop": yields run:finished and terminates
 * - "summarize": (Phase 2+) triggers summary injection
 *
 * Morphology: Event Observer
 */
export function withMaxTokens(opts: {
  maxTotalTokens: number;
  onExceeded?: "warn" | "stop" | "summarize";
}): Plugin {
  const onExceeded = opts.onExceeded ?? "stop";

  return (inner) =>
    async function* (input: AgentInput): AgentGenerator {
      const runId = input.runId ?? "unknown";
      let cumulativeTokens = 0;
      let exceededWarned = false;

      for await (const event of inner(input)) {
        if (event.type === "llm:done") {
          cumulativeTokens = event.usage.input + event.usage.output;
        }

        if (event.type === "step:completed") {
          // Check if we're over the token limit
          if (cumulativeTokens > opts.maxTotalTokens) {
            switch (onExceeded) {
              case "stop": {
                // Terminate the run
                yield event; // Yield the current step:completed first
                yield {
                  type: "run:finished",
                  outcome: {
                    runId,
                    messages: [],
                    text: "",
                    workingMemory: {},
                    tokenUsage: {
                      input: cumulativeTokens,
                      output: 0,
                      total: cumulativeTokens,
                    },
                    finishReason: "error",
                    totalSteps: event.step,
                    error: {
                      code: "LLM_TOKEN_LIMIT",
                      message: `Exceeded max total tokens (${cumulativeTokens} > ${opts.maxTotalTokens})`,
                      retryable: false,
                    },
                  },
                };
                return;
              }
              case "warn": {
                if (!exceededWarned) {
                  exceededWarned = true;
                  // Phase 2+: inject warning message into LLM context
                  // For now, just let it continue and mark as warned
                }
                break;
              }
              case "summarize": {
                // Phase 2+: trigger summary compression
                // For now, fall through to stop
                yield event;
                yield {
                  type: "run:finished",
                  outcome: {
                    runId,
                    messages: [],
                    text: "",
                    workingMemory: {},
                    tokenUsage: {
                      input: cumulativeTokens,
                      output: 0,
                      total: cumulativeTokens,
                    },
                    finishReason: "error",
                    totalSteps: event.step,
                    error: {
                      code: "LLM_TOKEN_LIMIT",
                      message: `Exceeded max total tokens (${cumulativeTokens} > ${opts.maxTotalTokens})`,
                      retryable: false,
                    },
                  },
                };
                return;
              }
            }
          }
        }

        yield event;
      }
    };
}
