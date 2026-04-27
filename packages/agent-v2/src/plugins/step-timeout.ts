import type { Plugin } from "../plugin.js";
import type { AgentInput } from "../types.js";
import type { AgentGenerator } from "../types.js";

/**
 * Per-step timeout plugin.
 *
 * Watches for step:started/step:completed pairs.
 * If a step exceeds durationMs, cancels the run.
 *
 * Morphology: Event Observer
 */
export function withStepTimeout(opts: { durationMs: number }): Plugin {
  return (inner) =>
    async function* (input: AgentInput): AgentGenerator {
      const runId = input.runId ?? "unknown";
      let currentStep = 0;
      let stepStartTime = 0;
      let stepTimer: ReturnType<typeof setTimeout> | undefined;

      function clearStepTimer() {
        if (stepTimer !== undefined) {
          clearTimeout(stepTimer);
          stepTimer = undefined;
        }
      }

      for await (const event of inner(input)) {
        if (event.type === "step:started") {
          currentStep = event.step;
          stepStartTime = Date.now();

          // Set a timer for this step
          stepTimer = setTimeout(() => {
            // Step timed out — the next yield will be intercepted
            // by the outer logic
          }, opts.durationMs);
        }

        yield event;

        if (event.type === "step:completed") {
          clearStepTimer();

          const stepDuration = Date.now() - stepStartTime;
          if (stepDuration > opts.durationMs) {
            yield {
              type: "run:cancelled",
              runId,
              step: currentStep,
            };
            return;
          }
        }

        // Check if timer fired during event processing
        if (stepTimer && stepStartTime > 0) {
          const elapsed = Date.now() - stepStartTime;
          if (elapsed > opts.durationMs) {
            clearStepTimer();
            yield {
              type: "run:cancelled",
              runId,
              step: currentStep,
            };
            return;
          }
        }
      }

      clearStepTimer();
    };
}
