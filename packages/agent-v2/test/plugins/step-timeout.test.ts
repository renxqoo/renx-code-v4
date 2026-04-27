import { describe, it, expect } from "vitest";
import { pipe } from "../../src/plugin.js";
import { withStepTimeout } from "../../src/plugins/step-timeout.js";
import { agent } from "../../src/agent.js";
import { userMessage } from "../../src/message.js";
import { echoTool } from "../fixtures/mock-tools.js";
import {
  createSingleResponseClient,
  createTextDeltaChunk,
  createFinishChunk,
} from "../fixtures/mock-llm-client.js";
import type { AgentEvent } from "../../src/events.js";

describe("withStepTimeout", () => {
  it("allows completion when step completes within time limit", async () => {
    const fn = pipe(withStepTimeout({ durationMs: 60000 }), agent);

    const events: AgentEvent[] = [];
    for await (const event of fn({
      model: "test",
      systemPrompt: "Be helpful",
      messages: [userMessage("Hi")],
      runId: "step-ok",
      llmClient: createSingleResponseClient([
        createTextDeltaChunk("Fast"),
        createFinishChunk("stop"),
      ]),
    })) {
      events.push(event);
    }

    expect(events.some(e => e.type === "run:finished")).toBe(true);
    expect(events.some(e => e.type === "run:cancelled")).toBe(false);
  });

  it("tracks per-step timing across multiple steps", async () => {
    const fn = pipe(withStepTimeout({ durationMs: 60000 }), agent);

    const events: AgentEvent[] = [];
    for await (const event of fn({
      model: "test",
      systemPrompt: "Use tools",
      messages: [userMessage("echo hello")],
      tools: [echoTool],
      runId: "step-multi",
      llmClient: {
        stream: async function* () {
          yield { type: "text-delta" as const, delta: "First step" };
          yield { type: "tool-call-delta" as const, id: "c1", name: "echo", argsDelta: '{"message":"hello"}' };
          yield { type: "finish" as const, finishReason: "tool_calls", usage: { input: 10, output: 5 } };
        },
      },
      maxSteps: 1,
    })) {
      events.push(event);
    }

    expect(events.some(e => e.type === "run:cancelled")).toBe(false);
  });
});
