import zod from "zod";


export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type AgentTool = {
  id: string;
  name: string;
  /** 发给模型的工具说明；缺省为 `name`。 */
  description?: string;
  type: "read_only" | "write_only" | "read_write";
  execute: (args: Record<string, unknown>) => Promise<AgentToolExecutionResult>;
  schema: zod.ZodSchema;
};


export type AgentToolExecutionResult = {
  success: boolean;
  content: string;
  metadata: Record<string, unknown>;
}
