import type { Tool } from "../tool.js";
import type { CanonicalToolSchema, JsonSchema } from "../llm-client.js";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Convert a Tool to its CanonicalToolSchema representation for LLM API calls.
 */
export function toolToCanonical(tool: Tool): CanonicalToolSchema {
  const jsonSchema = zodToJsonSchema(tool.parameters, { $refStrategy: "none" });
  const { $schema, ...schema } = jsonSchema as Record<string, unknown> & {
    $schema?: string;
  };
  return {
    name: tool.name,
    description: tool.description,
    parameters: schema as JsonSchema,
  };
}
