import type { Plugin } from "../plugin.js";
import type { AgentInput } from "../types.js";
import type { AgentGenerator, AgentResult } from "../types.js";

/**
 * Cache store interface for withCache plugin.
 */
export type CacheStore = {
  get: (key: string) => Promise<AgentResult | undefined>;
  set: (key: string, result: AgentResult, ttlMs: number) => Promise<void>;
};

/**
 * Cache plugin — caches agent results to avoid redundant LLM calls.
 *
 * Computes a cache key from the input (default: systemPrompt + last user message).
 * On cache hit: yields synthetic run:started + run:finished with cached result.
 * On cache miss: runs the agent, captures result, caches it, forwards all events.
 *
 * Morphology: Event Observer
 */
export function withCache(opts: {
  store: CacheStore;
  keyFn?: (input: AgentInput) => string;
  ttlMs?: number;
}): Plugin {
  const ttlMs = opts.ttlMs ?? 3600000; // 1 hour default

  const defaultKeyFn = (input: AgentInput): string => {
    // Simple stable key: system prompt + last message content
    const lastMsg = input.messages[input.messages.length - 1];
    const lastContent =
      typeof lastMsg?.content === "string"
        ? lastMsg.content
        : JSON.stringify(lastMsg?.content ?? "");
    return `${input.systemPrompt}|${lastContent}`;
  };

  const keyFn = opts.keyFn ?? defaultKeyFn;

  return (inner) =>
    async function* (input: AgentInput): AgentGenerator {
      const cacheKey = keyFn(input);
      const runId = input.runId ?? "unknown";

      // Check cache
      const cached = await opts.store.get(cacheKey);
      if (cached) {
        // Cache hit — yield synthetic events
        yield {
          type: "run:started",
          runId,
          model: input.model,
          systemPrompt: input.systemPrompt,
          tools: input.tools?.map((t) => t.name),
          maxSteps: input.maxSteps ?? 10,
        };
        yield {
          type: "run:finished",
          outcome: cached,
        };
        return;
      }

      // Cache miss — run the agent and capture result
      for await (const event of inner(input)) {
        if (event.type === "run:finished") {
          // Cache successful runs only
          if (event.outcome.finishReason === "stop") {
            await opts.store.set(cacheKey, event.outcome, ttlMs);
          }
        }
        yield event;
      }
    };
}
