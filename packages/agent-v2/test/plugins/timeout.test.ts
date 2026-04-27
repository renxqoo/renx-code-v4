import { describe, it, expect } from "vitest";
import { pipe } from "../../src/plugin.js";
import { withTimeout } from "../../src/plugins/timeout.js";
import { agent } from "../../src/agent.js";
import { userMessage } from "../../src/message.js";
import {
  createSingleResponseClient,
  createTextDeltaChunk,
  createFinishChunk,
} from "../fixtures/mock-llm-client.js";
import type { AgentEvent } from "../../src/events.js";

describe("withTimeout", () => {
  it("allows agent to complete when within time limit", async () => {
    const fn = pipe(withTimeout({ durationMs: 30000 }), agent);

    const events: AgentEvent[] = [];
    for await (const event of fn({
      model: "test",
      systemPrompt: "Be helpful",
      messages: [userMessage("Hi")],
      runId: "timeout-ok",
      llmClient: createSingleResponseClient([
        createTextDeltaChunk("Hello"),
        createFinishChunk("stop"),
      ]),
    })) {
      events.push(event);
    }

    expect(events.some(e => e.type === "run:finished")).toBe(true);
    expect(events.some(e => e.type === "run:cancelled")).toBe(false);
  });

  it("cancels immediately when duration is 0 (already exceeded)", async () => {
    const fn = pipe(withTimeout({ durationMs: 0 }), agent);

    const events: AgentEvent[] = [];
    for await (const event of fn({
      model: "test",
      systemPrompt: "Be helpful",
      messages: [userMessage("Hi")],
      runId: "timeout-zero",
      llmClient: {} as any,
    })) {
      events.push(event);
    }

    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("run:cancelled");
    expect((events[0] as any).runId).toBe("timeout-zero");
  });

  it("completes without cancelling when agent finishes fast enough", async () => {
    const fn = pipe(withTimeout({ durationMs: 60000 }), agent);

    const events: AgentEvent[] = [];
    for await (const event of fn({
      model: "test",
      systemPrompt: "Be helpful",
      messages: [userMessage("Hi")],
      runId: "timeout-long",
      llmClient: createSingleResponseClient([
        createTextDeltaChunk("Fast response"),
        createFinishChunk("stop"),
      ]),
    })) {
      events.push(event);
    }

    expect(events.some(e => e.type === "run:finished")).toBe(true);
    expect(events.some(e => e.type === "run:cancelled")).toBe(false);
  });
});
