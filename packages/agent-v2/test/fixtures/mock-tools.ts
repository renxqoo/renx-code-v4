import { z } from "zod";
import type { Tool } from "../../src/tool.js";
import { HandoffSignal } from "../../src/handoff-signal.js";

// Echo tool: returns the input as-is
export const echoTool: Tool<{ message: string }, { echoed: string }> = {
  name: "echo",
  description: "Echo the message back",
  parameters: z.object({
    message: z.string().describe("The message to echo"),
  }),
  async execute(input) {
    return { echoed: input.message };
  },
};

// Greet tool: returns a greeting
export const greetTool: Tool<{ name: string }, { greeting: string }> = {
  name: "greet",
  description: "Greet a person by name",
  parameters: z.object({
    name: z.string().describe("The name of the person to greet"),
  }),
  async execute(input) {
    return { greeting: `Hello, ${input.name}!` };
  },
};

// Calculator tool
export const calculatorTool: Tool<
  { operation: string; a: number; b: number },
  { result: number }
> = {
  name: "calculator",
  description: "Perform a calculation (add, subtract, multiply, divide)",
  parameters: z.object({
    operation: z.enum(["add", "subtract", "multiply", "divide"]),
    a: z.number(),
    b: z.number(),
  }),
  async execute(input) {
    switch (input.operation) {
      case "add":
        return { result: input.a + input.b };
      case "subtract":
        return { result: input.a - input.b };
      case "multiply":
        return { result: input.a * input.b };
      case "divide":
        return { result: input.a / input.b };
      default:
        throw new Error(`Unknown operation: ${input.operation}`);
    }
  },
};

// Failing tool: always throws
export const failingTool: Tool<{ reason?: string }, never> = {
  name: "fail",
  description: "A tool that always fails",
  parameters: z.object({
    reason: z.string().optional().describe("Reason for failure"),
  }),
  async execute(input) {
    throw new Error(input.reason ?? "This tool always fails");
  },
};

// Handoff tool: throws HandoffSignal
export function createHandoffTool(
  targetAgentName = "target-agent",
  name = "handoff",
): Tool<{ reason: string }, never> {
  return {
    name,
    description: `Hand off to ${targetAgentName}`,
    parameters: z.object({
      reason: z.string().describe("Reason for handoff"),
    }),
    async execute(input) {
      throw new HandoffSignal(targetAgentName, input.reason);
    },
  };
}

// Working memory tool: reads and updates working memory
export const memoryTool: Tool<
  { key: string; value?: string },
  { key: string; previousValue?: unknown }
> = {
  name: "memory",
  description: "Read or write to working memory",
  parameters: z.object({
    key: z.string().describe("Memory key"),
    value: z.string().optional().describe("Value to set (omit to read)"),
  }),
  async execute(input, ctx) {
    const previousValue = ctx.workingMemory[input.key];
    if (input.value !== undefined) {
      ctx.workingMemory[input.key] = input.value;
    }
    return { key: input.key, previousValue };
  },
};

// Slow tool: simulates a slow operation
export const slowTool: Tool<{ delayMs: number }, { done: boolean }> = {
  name: "slow",
  description: "A slow tool that takes time to complete",
  parameters: z.object({
    delayMs: z.number().describe("Delay in milliseconds"),
  }),
  async execute(input) {
    await new Promise((resolve) => setTimeout(resolve, input.delayMs));
    return { done: true };
  },
};
