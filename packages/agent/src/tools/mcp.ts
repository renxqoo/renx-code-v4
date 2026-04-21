import type { ZodType } from "zod";
import type { AgentTool, AgentToolExecutionResult } from "./type";

export type McpCallToolRequest<TArgs extends Record<string, unknown> = Record<string, unknown>> = {
  server: string;
  toolName: string;
  arguments: TArgs;
};

export type McpCallToolResponse = {
  content: string;
  metadata?: Record<string, unknown>;
  success?: boolean;
};

export interface McpToolClient {
  callTool<TArgs extends Record<string, unknown>>(request: McpCallToolRequest<TArgs>): Promise<McpCallToolResponse>;
}

export type CreateMcpToolOptions<TArgs extends Record<string, unknown>> = {
  id: string;
  name: string;
  description?: string;
  type: "read_only" | "write_only" | "read_write";
  schema: ZodType<TArgs>;
  client: McpToolClient;
  server: string;
  toolName?: string;
  timeoutMs?: number;
  mapResult?: (result: McpCallToolResponse, args: TArgs) => AgentToolExecutionResult;
};

export function createMcpTool<TArgs extends Record<string, unknown>>(
  options: CreateMcpToolOptions<TArgs>,
): AgentTool<TArgs> {
  return {
    id: options.id,
    name: options.name,
    description: options.description,
    type: options.type,
    schema: options.schema,
    timeoutMs: options.timeoutMs,
    async execute(args: TArgs): Promise<AgentToolExecutionResult> {
      const result = await options.client.callTool({
        server: options.server,
        toolName: options.toolName ?? options.name,
        arguments: args,
      });
      if (options.mapResult) {
        return options.mapResult(result, args);
      }
      return {
        success: result.success ?? true,
        content: result.content,
        metadata: result.metadata ?? {},
      };
    },
  };
}
