import { z } from "zod";
import type { Message } from "../message.js";
import type { Tool } from "../tool.js";
import { HandoffSignal } from "../handoff-signal.js";

/**
 * Create a handoff Tool that triggers control transfer to another agent.
 *
 * When the LLM invokes this tool, it throws a HandoffSignal,
 * which the agent() generator catches and converts to a handoff event
 * and a run:finished with finishReason "handoff".
 *
 * per DESIGN.md §5.6
 */
export function handoff(opts: {
  to: string;
  name?: string;
  description?: string;
  filterMessages?: (messages: Message[]) => Message[];
}): Tool<{ reason?: string }, never> {
  return {
    name: opts.name ?? `handoff_to_${opts.to}`,
    description:
      opts.description ??
      `Transfer control to the ${opts.to} agent. Use this when you need to route the conversation to another agent.`,
    parameters: z.object({
      reason: z.string().optional().describe("Reason for handoff"),
    }) as unknown as Tool["parameters"],
    execute: async (input: { reason?: string }) => {
      // filterMessages can be used before handoff in Phase 2+
      throw new HandoffSignal(
        opts.to,
        input.reason ?? `Handoff to ${opts.to}`,
      );
    },
  };
}
