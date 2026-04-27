import type { Plugin } from "../plugin.js";
import type { AgentInput } from "../types.js";
import type { AgentGenerator } from "../types.js";
import type { AgentEvent } from "../events.js";

/**
 * Retry plugin with exponential backoff.
 *
 * Retries the entire agent run on retryable LLM errors.
 * Listens for llm:done with finishReason "error" or run:finished with error.
 *
 * Morphology: Event Observer
 */
export function withRetry(opts: {
  maxRetries?: number;
  baseDelayMs?: number;
  backoffMultiplier?: number;
  maxDelayMs?: number;
  isRetryable?: (event: AgentEvent) => boolean;
}): Plugin {
  const maxRetries = opts.maxRetries ?? 2;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const backoffMultiplier = opts.backoffMultiplier ?? 2;
  const maxDelayMs = opts.maxDelayMs ?? 30000;

  const defaultRetryable = (event: AgentEvent): boolean => {
    if (event.type === "llm:done") {
      return event.finishReason === "error" && !!event.error?.retryable;
    }
    if (event.type === "run:finished") {
      return !!event.outcome.error?.retryable;
    }
    return false;
  };
  const isRetryable = opts.isRetryable ?? defaultRetryable;

  async function delay(attempt: number): Promise<void> {
    const delayMs = Math.min(
      baseDelayMs * Math.pow(backoffMultiplier, attempt),
      maxDelayMs,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return (inner) =>
    async function* (input: AgentInput): AgentGenerator {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const events: AgentEvent[] = [];
        let shouldRetry = false;
        let retryTrigger: AgentEvent | undefined;

        // Collect all events from this attempt
        for await (const event of inner(input)) {
          events.push(event);
          if (isRetryable(event)) {
            shouldRetry = true;
            retryTrigger = event;
          }
        }

        // If no retry needed, yield all events and return
        if (!shouldRetry || attempt >= maxRetries) {
          for (const event of events) {
            yield event;
          }
          return;
        }

        // Retry: discard events from this attempt, wait, then loop
        const retryStep =
          retryTrigger?.type === "llm:done" ? retryTrigger.step : "?";
        const retryReason =
          retryTrigger?.type === "llm:done"
            ? retryTrigger.error?.message
            : retryTrigger?.type === "run:finished"
              ? retryTrigger.outcome.error?.message
              : "unknown";
        await delay(attempt);
        // Continue to next iteration — the for loop handles maxRetries
        // Note: we intentionally suppress the unused variable warning by
        // logging retry info at debug level. In Phase 2, this would be
        // logged via the withLogging plugin (which wraps withRetry).
        void retryStep;
        void retryReason;
        continue;
      }
    };
}
