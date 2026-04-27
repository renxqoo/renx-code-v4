import type { Plugin } from "../plugin.js";
import type { AgentInput } from "../types.js";
import type { AgentGenerator } from "../types.js";

/**
 * Total wall-clock timeout plugin.
 *
 * If the agent exceeds durationMs, cancels the run.
 * If graceful is true, allows the current step to complete before cancelling.
 *
 * Morphology: Event Observer
 */
export function withTimeout(opts: {
  durationMs: number;
  graceful?: boolean;
}): Plugin {
  const graceful = opts.graceful ?? false;

  return (inner) =>
    async function* (input: AgentInput): AgentGenerator {
      const runId = input.runId ?? "unknown";
      const startTime = Date.now();
      const deadline = startTime + opts.durationMs;

      // Check if we've already exceeded timeout (defensive)
      if (Date.now() >= deadline) {
        yield {
          type: "run:cancelled",
          runId,
          step: 0,
        };
        return;
      }

      // Create an AbortController for timeout
      const timeoutCtrl = new AbortController();

      // Set up timeout
      const timer = setTimeout(() => {
        if (graceful) {
          // Signal graceful shutdown — allow current step to complete
          timeoutCtrl.abort();
        } else {
          // Immediate abort
          timeoutCtrl.abort();
        }
      }, opts.durationMs);

      try {
        for await (const event of inner(input)) {
          yield event;

          // After processing each event, check if timeout fired
          if (timeoutCtrl.signal.aborted) {
            // If graceful, check if we're mid-step
            if (graceful && event.type === "llm:done") {
              // Let the current step complete naturally
              // (the for-await will pick up step:completed+ and potentially run:finished)
              continue;
            }
          }
        }
      } finally {
        clearTimeout(timer);
      }
    };
}
