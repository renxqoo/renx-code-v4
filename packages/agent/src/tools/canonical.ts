import type { CanonicalTool } from "@renx/provider";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { AgentTool } from "./type";

/**
 * 将本地 `AgentTool`（Zod）投影为发给模型的 `CanonicalTool`。
 */
export function agentToolToCanonical(tool: AgentTool, descriptionOverride?: string): CanonicalTool {
  const parameters = zodToJsonSchema(tool.schema, {
    $refStrategy: "none",
  }) as Record<string, unknown>;

  return {
    name: tool.name,
    description: descriptionOverride ?? tool.description ?? tool.name,
    parameters,
  };
}

export function toolsToCanonical(tools: AgentTool[]): CanonicalTool[] {
  return tools.map((t) => agentToolToCanonical(t));
}
