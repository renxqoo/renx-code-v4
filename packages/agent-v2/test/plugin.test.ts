import { describe, it, expect } from "vitest";
import { pipe } from "../src/plugin.js";
import type { Plugin, AgentFn } from "../src/index.js";
import type { AgentEvent, AgentInput, AgentGenerator } from "../src/index.js";
import {
  createSingleResponseClient,
  createTextDeltaChunk,
  createFinishChunk,
  createToolCallDeltaChunk,
} from "./fixtures/mock-llm-client.js";
import { echoTool, greetTool } from "./fixtures/mock-tools.js";
import { userMessage } from "../src/message.js";
import { agent } from "../src/agent.js";

async function collectEvents(gen: AgentGenerator): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe("Plugin", () => {
  // 1. pipe() composes left-to-right
  it("pipe() composes left-to-right (p1 outer, p2 inner, agent innermost)", async () => {
    const executionOrder: string[] = [];

    const p1: Plugin = (inner) =>
      async function* (input) {
        executionOrder.push("p1:enter");
        yield* inner(input);
        executionOrder.push("p1:exit");
      };

    const p2: Plugin = (inner) =>
      async function* (input) {
        executionOrder.push("p2:enter");
        yield* inner(input);
        executionOrder.push("p2:exit");
      };

    const composed = pipe(p1, p2, agent);

    await collectEvents(
      composed({
        model: "test",
        systemPrompt: "Hi",
        messages: [userMessage("Hello")],
        llmClient: createSingleResponseClient([
          createTextDeltaChunk("Reply"),
          createFinishChunk("stop"),
        ]),
      }),
    );

    // p1 is outer → enters first, exits last
    expect(executionOrder).toEqual([
      "p1:enter",
      "p2:enter",
      "p2:exit",
      "p1:exit",
    ]);
  });

  // 2. Observer Plugin wraps agent, yields events unchanged
  it("observer plugin wraps agent and sees all events unchanged", async () => {
    const observed: string[] = [];

    const observer: Plugin = (inner) =>
      async function* (input) {
        for await (const event of inner(input)) {
          observed.push(event.type);
          yield event;
        }
      };

    const composed = pipe(observer, agent);

    const events = await collectEvents(
      composed({
        model: "test",
        systemPrompt: "Hi",
        messages: [userMessage("Hello")],
        llmClient: createSingleResponseClient([
          createTextDeltaChunk("Hi!"),
          createFinishChunk("stop"),
        ]),
      }),
    );

    expect(observed).toContain("run:started");
    expect(observed).toContain("llm:delta");
    expect(observed).toContain("llm:done");
    expect(observed).toContain("run:finished");

    // The actual events should also be yielded
    const types = events.map((e) => e.type);
    expect(types).toContain("run:started");
    expect(types).toContain("llm:delta");
    expect(types).toContain("llm:done");
    expect(types).toContain("run:finished");
  });

  // 3. Input injection Plugin modifies input.onTools
  it("input injection plugin modifies input.onTools", async () => {
    let injectedCalled = false;

    const toolGate: Plugin = (inner) =>
      async function* (input) {
        const originalOnTools = input.onTools;
        const injectedInput: AgentInput = {
          ...input,
          onTools(ctx) {
            injectedCalled = true;
            // Still execute all tools, but track that we were called
            return { action: "execute" };
          },
        };
        yield* inner(injectedInput);
      };

    const composed = pipe(toolGate, agent);

    const events = await collectEvents(
      composed({
        model: "test",
        systemPrompt: "Use tools",
        messages: [userMessage("echo hello")],
        tools: [echoTool],
        llmClient: createSingleResponseClient([
          createToolCallDeltaChunk("c1", "echo", '{"message":"hello"}'),
          createFinishChunk("tool_calls", { input: 8, output: 4 }),
        ]),
      }),
    );

    expect(injectedCalled).toBe(true);
    expect(events.some((e) => e.type === "tool:result")).toBe(true);
  });

  // 4. Multiple plugins composed — verify layering order
  it("multiple plugins composed — correct layering order", async () => {
    const hooks: string[] = [];

    const makeTrackingPlugin = (name: string): Plugin =>
      (inner) =>
        async function* (input) {
          hooks.push(`${name}:before`);
          yield* inner(input);
          hooks.push(`${name}:after`);
        };

    const composed = pipe(
      makeTrackingPlugin("auth"),
      makeTrackingPlugin("logging"),
      makeTrackingPlugin("cache"),
      agent,
    );

    await collectEvents(
      composed({
        model: "test",
        systemPrompt: "Hi",
        messages: [userMessage("Hello")],
        llmClient: createSingleResponseClient([
          createTextDeltaChunk("OK"),
          createFinishChunk("stop"),
        ]),
      }),
    );

    // auth outer → enters first, exits last
    // cache inner → enters last, exits first
    expect(hooks).toEqual([
      "auth:before",
      "logging:before",
      "cache:before",
      "cache:after",
      "logging:after",
      "auth:after",
    ]);
  });
});
