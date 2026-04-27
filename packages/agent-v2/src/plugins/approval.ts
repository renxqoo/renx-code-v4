import type { Plugin } from "../plugin.js";
import type { AgentInput } from "../types.js";
import type { AgentGenerator } from "../types.js";
import type { OnToolsContext, OnToolsDecision } from "../llm-client.js";
import type { ToolCallInfo } from "../tool.js";

/**
 * Approval decision returned by the user-provided approve() callback.
 */
export type ApproveDecision =
  | { action: "allow" }
  | { action: "deny"; callIds: string[] }
  | { action: "abort"; reason: string }
  | { action: "pause"; callIds: string[] };

/**
 * Approval plugin — intercepts tool calls and requires human approval.
 *
 * Injects input.onTools to implement a tool execution guard.
 * Supports first-run approval (calls approve()) and resume approval
 * (reads from priorApprovals).
 *
 * Morphology: Input Injector
 */
export function withApproval(opts: {
  approve: (toolCalls: ToolCallInfo[]) => Promise<ApproveDecision>;
}): Plugin {
  return (inner) =>
    async function* (input: AgentInput): AgentGenerator {
      // If there's already an onTools from another plugin, compose them.
      // Otherwise, create the approval guard directly.
      const existingOnTools = input.onTools;

      const guardedOnTools = async (
        ctx: OnToolsContext,
      ): Promise<OnToolsDecision> => {
        // Resume branch: priorApprovals exists, deliver pre-recorded decision
        if (
          ctx.priorApprovals &&
          ctx.priorApprovals.length > 0
        ) {
          // Check if any calls were denied in the resume approvals
          const deniedIds = ctx.priorApprovals
            .filter((a) => a.action === "deny")
            .map((a) => a.callId);

          if (deniedIds.length > 0) {
            return {
              action: "deny",
              callIds: deniedIds,
              reason: `Previously denied by human`,
            };
          }

          // All allowed — let them execute
          return { action: "execute" };
        }

        // First-run branch: call approve()
        const decision = await opts.approve(ctx.toolCalls);

        switch (decision.action) {
          case "allow":
            return { action: "execute" };
          case "deny":
            return {
              action: "deny",
              callIds: decision.callIds,
              reason: `Denied by human`,
            };
          case "abort":
            return { action: "abort", reason: decision.reason };
          case "pause":
            return {
              action: "pause",
              callIds: decision.callIds,
              reason: "Awaiting human approval",
            };
        }
      };

      // Compose with existing onTools if present
      const finalOnTools = existingOnTools
        ? async (ctx: OnToolsContext): Promise<OnToolsDecision> => {
            // First run through the existing guard
            const existingDecision = await existingOnTools(ctx);
            if (existingDecision.action !== "execute") {
              return existingDecision;
            }
            // Then run through approval guard
            return guardedOnTools(ctx);
          }
        : guardedOnTools;

      const guardedInput: AgentInput = {
        ...input,
        onTools: finalOnTools,
      };

      yield* inner(guardedInput);
    };
}
