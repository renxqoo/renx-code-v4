import { z } from "zod";
import type { AgentInput, AgentGenerator } from "../types.js";
import type { Tool, ToolContext } from "../tool.js";
import type { AgentEvent } from "../events.js";

/**
 * Wrap a child agent as a Tool so a parent agent can invoke it via LLM tool calling.
 *
 * The child runs as a sub-generator. onChildEvent optionally forwards child events
 * (e.g. for streaming). mapResult converts the child's final result into a string
 * for the parent's tool result message.
 *
 * per DESIGN.md §5.5
 */
export function agentAsTool(opts: {
  name: string;
  description: string;
  agent: (input: AgentInput) => AgentGenerator;
  buildInput: (
    args: Record<string, unknown>,
    parent: {
      model: string;
      workingMemory: Record<string, unknown>;
      signal: AbortSignal;
    },
  ) => AgentInput;
  onChildEvent?: (event: AgentEvent) => void;
  mapResult?: (result: { text: string; messages: unknown[] }) => string;
}): Tool<Record<string, unknown>, string> {
  return {
    name: opts.name,
    description: opts.description,
    // Use a loose passthrough schema — validation is done by the LLM
    parameters: z.object({}).passthrough() as unknown as Tool["parameters"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (args: any, ctx: ToolContext): Promise<string> => {
      const input = opts.buildInput(args, {
        model: ctx.workingMemory.model as string ?? "unknown",
        workingMemory: ctx.workingMemory,
        signal: ctx.signal,
      });

      let finalText = "";
      const allMessages: unknown[] = [];

      for await (const event of opts.agent(input)) {
        opts.onChildEvent?.(event);

        if (event.type === "llm:delta") {
          finalText += event.delta;
        }
        if (event.type === "run:finished") {
          finalText = event.outcome.text || finalText;
          for (const msg of event.outcome.messages) {
            allMessages.push(msg);
          }
          // Write child's working memory back to parent
          Object.assign(ctx.workingMemory, event.outcome.workingMemory);
        }
      }

      if (opts.mapResult) {
        return opts.mapResult({ text: finalText, messages: allMessages });
      }

      return finalText || "Task completed.";
    },
  };
}
