import { describe, it, expect } from "vitest";
import { getRunManager } from "../../src/runner/manager.js";
import { agent } from "../../src/agent.js";
import { userMessage } from "../../src/message.js";
import {
  createSingleResponseClient,
  createTextDeltaChunk,
  createFinishChunk,
} from "../fixtures/mock-llm-client.js";
import type { AgentEvent } from "../../src/events.js";
import type { ManagedRun } from "../../src/runner/manager.js";

async function collectStream(run: ManagedRun): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run.stream()) {
    events.push(event);
  }
  return events;
}

describe("RunManager", () => {
  it("creates a run with status 'ready'", () => {
    const mgr = getRunManager(agent);

    const run = mgr.create({
      model: "test",
      systemPrompt: "Be helpful",
      messages: [userMessage("Hi")],
      llmClient: createSingleResponseClient([
        createTextDeltaChunk("Hello"),
        createFinishChunk("stop"),
      ]),
    });

    expect(run.runId).toBeTypeOf("string");
    expect(run.runId.length).toBeGreaterThan(0);
    expect(run.status()).toBe("ready");
  });

  it("stream starts the agent and yields events", async () => {
    const mgr = getRunManager(agent);

    const run = mgr.create({
      model: "test",
      systemPrompt: "Be helpful",
      messages: [userMessage("Hi")],
      llmClient: createSingleResponseClient([
        createTextDeltaChunk("Hello world"),
        createFinishChunk("stop", { input: 5, output: 3 }),
      ]),
    });

    const events = await collectStream(run);

    expect(events.some(e => e.type === "run:started")).toBe(true);
    expect(events.some(e => e.type === "llm:delta")).toBe(true);
    expect(events.some(e => e.type === "run:finished")).toBe(true);

    const persisted = await run.events();
    expect(persisted.length).toBeGreaterThan(0);
  });

  it("provides generated runId when not provided", () => {
    const mgr = getRunManager(agent);
    const run = mgr.create({
      model: "test",
      systemPrompt: "Be helpful",
      messages: [userMessage("Hi")],
      llmClient: createSingleResponseClient([
        createTextDeltaChunk("Hi"),
        createFinishChunk("stop"),
      ]),
    });

    expect(run.runId).toBeTypeOf("string");
    expect(run.runId.length).toBeGreaterThan(0);
  });

  it("provided runId is preserved", () => {
    const mgr = getRunManager(agent);
    const run = mgr.create({
      runId: "my-custom-id",
      model: "test",
      systemPrompt: "Be helpful",
      messages: [userMessage("Hi")],
      llmClient: createSingleResponseClient([
        createTextDeltaChunk("Hi"),
        createFinishChunk("stop"),
      ]),
    });

    expect(run.runId).toBe("my-custom-id");
  });

  it("list returns created runs", async () => {
    const mgr = getRunManager(agent);

    mgr.create({
      model: "test",
      systemPrompt: "Be helpful",
      messages: [userMessage("Hi")],
      llmClient: createSingleResponseClient([
        createTextDeltaChunk("Hi"),
        createFinishChunk("stop"),
      ]),
    });

    const runs = await mgr.list();
    expect(runs.length).toBeGreaterThan(0);
  });

  it("list filters by status", async () => {
    const mgr = getRunManager(agent);

    const run = mgr.create({
      model: "test",
      systemPrompt: "Be helpful",
      messages: [userMessage("Hi")],
      llmClient: createSingleResponseClient([
        createTextDeltaChunk("Hi"),
        createFinishChunk("stop"),
      ]),
    });

    const readyRuns = await mgr.list({ status: "ready" });
    expect(readyRuns.some(r => r.runId === run.runId)).toBe(true);
  });

  it("cancel transitions to cancelled status", async () => {
    const mgr = getRunManager(agent);

    const run = mgr.create({
      model: "test",
      systemPrompt: "Be helpful",
      messages: [userMessage("Hi")],
      llmClient: createSingleResponseClient([
        createTextDeltaChunk("Hello"),
        createFinishChunk("stop"),
      ]),
    });

    await run.cancel();

    // Verify cancellation by checking the state
    const state = run.state();
    expect(state.status).toBe("cancelled");
  });
});
