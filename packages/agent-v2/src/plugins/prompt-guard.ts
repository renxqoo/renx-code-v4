import type { Plugin } from "../plugin.js";
import type { AgentInput } from "../types.js";
import type { AgentGenerator } from "../types.js";

/**
 * Prompt guard plugin — checks if input is safe before running the agent.
 *
 * If detect() returns false, the agent is blocked and onBlock() is called.
 * No agent events are yielded.
 *
 * Morphology: Event Observer (input check before delegation)
 */
export function withPromptGuard(opts: {
  detect: (input: AgentInput) => Promise<boolean>;
  onBlock: () => Promise<void>;
}): Plugin {
  return (inner) =>
    async function* (input: AgentInput): AgentGenerator {
      const isSafe = await opts.detect(input);

      if (!isSafe) {
        await opts.onBlock();
        // Don't yield any events — agent is blocked
        return;
      }

      yield* inner(input);
    };
}
