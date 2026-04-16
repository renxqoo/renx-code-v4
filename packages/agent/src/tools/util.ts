import type { AgentTool } from "./type";

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
