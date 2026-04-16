import type { AgentTool } from "./type";
import type { AgentToolExecutionResult } from "./type";

export const validateTool = ({ toolCall, args }: { toolCall: AgentTool; args: Record<string, unknown> }) => {
  if (!toolCall.name) {
    throw new Error("Tool name is required");
  }

  if (!toolCall.id) {
    throw new Error("Tool id is required");
  }

  const result = toolCall.schema.safeParse(args);

  if (!result.success) {
    throw result.error;
  }

  return result.data;
};

/**
 * Build a standardized failure result for a tool execution error.
 */
export function toolResultError(name: string, callId: string, args: Record<string, unknown>, error: Error): AgentToolExecutionResult {
  return {
    success: false,
    content: `tool [${name}] execution failed: ${error.toString()}`,
    metadata: { name, id: callId, args, error: error.toString() },
  };
}
