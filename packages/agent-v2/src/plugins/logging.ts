import type { Plugin } from "../plugin.js";
import type { AgentInput } from "../types.js";
import type { AgentGenerator } from "../types.js";
import type { Logger } from "../utils/logger.js";

/**
 * Event observer plugin that logs agent events.
 *
 * Morphology: Event Observer
 */
export function withLogging(opts: {
  logger: Logger;
  level?: "debug" | "info";
  includeDelta?: boolean;
}): Plugin {
  const level = opts.level ?? "debug";
  const includeDelta = opts.includeDelta ?? false;

  return (inner) =>
    async function* (input: AgentInput): AgentGenerator {
      const runId = input.runId ?? "<pending>";
      const startTime = Date.now();

      opts.logger[level](`agent:start`, { runId });

      try {
        for await (const event of inner(input)) {
          if (event.type === "llm:delta" && !includeDelta) {
            // Skip noisy delta events unless explicitly included
            yield event;
            continue;
          }
          opts.logger[level](`agent:event`, {
            runId,
            eventType: event.type,
            ...("step" in event ? { step: event.step } : {}),
            ...(event.type === "llm:delta"
              ? { deltaLength: event.delta.length }
              : {}),
            ...(event.type === "llm:done"
              ? {
                  finishReason: event.finishReason,
                  usage: event.usage,
                }
              : {}),
            ...(event.type === "tool:start"
              ? { toolName: event.name }
              : {}),
            ...(event.type === "tool:result"
              ? { ok: event.ok, durationMs: event.durationMs }
              : {}),
          });
          yield event;
        }
      } catch (err) {
        opts.logger.error(`agent:error`, {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      const duration = Date.now() - startTime;
      opts.logger[level](`agent:end`, { runId, durationMs: duration });
    };
}
