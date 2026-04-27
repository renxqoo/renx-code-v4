import { describe, it, expect } from "vitest";
import { agentAsTool } from "../../src/multi-agent/agent-as-tool.js";
import { agent } from "../../src/agent.js";
import { userMessage } from "../../src/message.js";
import type { ToolContext } from "../../src/tool.js";
import type { AgentEvent } from "../../src/events.js";

describe("agentAsTool", () => {
  it("wraps a child agent as a Tool and returns its result", async () => {
    const childAgent = agent;
    const childTool = agentAsTool({
      name: "child_agent",
      description: "A child agent that answers questions",
      agent: childAgent,
      buildInput: (args, parent) => ({
        model: parent.model,
        systemPrompt: "You are a child agent. Answer concisely.",
        messages: [userMessage(args.question as string)],
        llmClient: {
          stream: async function* () {
            yield { type: "text-delta" as const, delta: "42" };
            yield { type: "finish" as const, finishReason: "stop", usage: { input: 5, output: 1 } };
          },
        },
      }),
    });

    const result = await childTool.execute(
      { question: "What is the answer?" },
      { workingMemory: { model: "test-model" }, signal: new AbortController().signal } as unknown as ToolContext,
    );

    expect(result).toBeTypeOf("string");
    expect(result).toContain("42");
  });

  it("forwards child events via onChildEvent", async () => {
    const childEvents: string[] = [];

    const childTool = agentAsTool({
      name: "child_agent",
      description: "A child agent",
      agent: agent,
      buildInput: (args, parent) => ({
        model: parent.model,
        systemPrompt: "Reply briefly",
        messages: [userMessage(args.question as string)],
        llmClient: {
          stream: async function* () {
            yield { type: "text-delta" as const, delta: "Response" };
            yield { type: "finish" as const, finishReason: "stop", usage: { input: 5, output: 3 } };
          },
        },
      }),
      onChildEvent: (event: AgentEvent) => {
        childEvents.push(event.type);
      },
    });

    await childTool.execute(
      { question: "Test" },
      { workingMemory: { model: "test-model" }, signal: new AbortController().signal } as unknown as ToolContext,
    );

    // Should have forwarded child events
    expect(childEvents.length).toBeGreaterThan(0);
    expect(childEvents).toContain("run:started");
  });

  it("uses custom mapResult to transform output", async () => {
    const childTool = agentAsTool({
      name: "child_agent",
      description: "A child agent",
      agent: agent,
      buildInput: (args, parent) => ({
        model: parent.model,
        systemPrompt: "Reply briefly",
        messages: [userMessage(args.question as string)],
        llmClient: {
          stream: async function* () {
            yield { type: "text-delta" as const, delta: "Hello world" };
            yield { type: "finish" as const, finishReason: "stop", usage: { input: 5, output: 3 } };
          },
        },
      }),
      mapResult: (result) => `Transformed: ${result.text}`,
    });

    const result = await childTool.execute(
      { question: "Test" },
      { workingMemory: { model: "test-model" }, signal: new AbortController().signal } as unknown as ToolContext,
    );

    expect(result).toBe("Transformed: Hello world");
  });

  it("propagates child workingMemory to parent ctx", async () => {
    const parentWM: Record<string, unknown> = { model: "test-model" };

    const childTool = agentAsTool({
      name: "child_agent",
      description: "A child agent",
      agent: agent,
      buildInput: (args, parent) => ({
        model: parent.model,
        systemPrompt: "Reply briefly.",
        messages: [userMessage(args.question as string)],
        workingMemory: { childKey: "childValue" },
        llmClient: {
          stream: async function* () {
            // The agent will set workingMemory in run:finished
            yield { type: "text-delta" as const, delta: "OK" };
            yield { type: "finish" as const, finishReason: "stop", usage: { input: 5, output: 2 } };
          },
        },
      }),
    });

    await childTool.execute(
      { question: "Test" },
      { workingMemory: parentWM, signal: new AbortController().signal } as unknown as ToolContext,
    );

    // Child's workingMemory should be written back to parent
    expect(parentWM.childKey).toBe("childValue");
  });

  it("uses model from parent context", async () => {
    let capturedModel: string | undefined;

    const childTool = agentAsTool({
      name: "child_agent",
      description: "A child agent",
      agent: agent,
      buildInput: (args, parent) => {
        capturedModel = parent.model;
        return {
          model: parent.model,
          systemPrompt: "Reply briefly.",
          messages: [userMessage(args.question as string)],
          llmClient: {
            stream: async function* () {
              yield { type: "text-delta" as const, delta: "OK" };
              yield { type: "finish" as const, finishReason: "stop", usage: { input: 5, output: 2 } };
            },
          },
        };
      },
    });

    await childTool.execute(
      { question: "Test" },
      { workingMemory: { model: "gpt-4-parent" }, signal: new AbortController().signal } as unknown as ToolContext,
    );

    expect(capturedModel).toBe("gpt-4-parent");
  });
});
