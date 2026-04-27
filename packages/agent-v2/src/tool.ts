import type { z } from "zod";

export type ToolContext = {
  runId: string;
  workingMemory: Record<string, unknown>;
  signal: AbortSignal;
};

export type Tool<I = any, O = any> = {
  name: string;
  description: string;
  parameters: z.ZodSchema<I>;
  execute: (input: I, ctx: ToolContext) => Promise<O>;
};

export type ToolCallInfo = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};
