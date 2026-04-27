import { describe, it, expect } from "vitest";
import { InMemoryAdapter } from "../../../src/runner/adapters/memory.js";
import type { RunState } from "../../../src/state.js";

function createTestState(runId: string, overrides?: Partial<RunState>): RunState {
  return {
    runId,
    status: "ready",
    model: "test-model",
    systemPrompt: "Be helpful",
    messages: [],
    workingMemory: {},
    tokenUsage: { input: 0, output: 0 },
    stepCount: 0,
    startedAt: Date.now(),
    lastActiveAt: Date.now(),
    ...overrides,
  };
}

describe("InMemoryAdapter", () => {
  it("saveState persists and loadState retrieves correctly", async () => {
    const adapter = new InMemoryAdapter();
    const state = createTestState("r1", { status: "running", stepCount: 3 });

    await adapter.saveState(state);
    const loaded = await adapter.loadState("r1");

    expect(loaded).not.toBeNull();
    expect(loaded!.runId).toBe("r1");
    expect(loaded!.status).toBe("running");
    expect(loaded!.stepCount).toBe(3);
  });

  it("loadState returns null for non-existent run", async () => {
    const adapter = new InMemoryAdapter();
    const result = await adapter.loadState("nonexistent");
    expect(result).toBeNull();
  });

  it("loadState returns a copy (not the original reference)", async () => {
    const adapter = new InMemoryAdapter();
    const state = createTestState("r1");
    await adapter.saveState(state);

    const loaded = await adapter.loadState("r1");
    loaded!.status = "failed";

    const reloaded = await adapter.loadState("r1");
    expect(reloaded!.status).toBe("ready");
  });

  it("appendEvents stores and getEvents retrieves events", async () => {
    const adapter = new InMemoryAdapter();
    const events = [
      { type: "run:started" as const, runId: "r1", model: "test", systemPrompt: "Hi", tools: [], maxSteps: 10 },
      { type: "run:finished" as const, outcome: { finishReason: "stop" as const, text: "OK", messages: [], workingMemory: {}, tokenUsage: { input: 5, output: 3 }, totalSteps: 1, runId: "r1" } },
    ];

    await adapter.appendEvents("r1", events);
    const retrieved = await adapter.getEvents("r1");

    expect(retrieved.length).toBe(2);
    expect(retrieved[0]!.type).toBe("run:started");
    expect(retrieved[1]!.type).toBe("run:finished");
  });

  it("getEvents supports offset and limit", async () => {
    const adapter = new InMemoryAdapter();
    const events = [
      { type: "run:started" as const, runId: "r1", model: "test", systemPrompt: "Hi", tools: [], maxSteps: 10 },
      { type: "step:started" as const, step: 1 },
      { type: "llm:done" as const, step: 1, finishReason: "stop", text: "OK", usage: { input: 5, output: 3 } },
      { type: "step:completed" as const, step: 1, finishReason: "stop", tokenUsage: { input: 5, output: 3 } },
      { type: "run:finished" as const, outcome: { finishReason: "stop" as const, text: "OK", messages: [], workingMemory: {}, tokenUsage: { input: 5, output: 3 }, totalSteps: 1, runId: "r1" } },
    ];
    await adapter.appendEvents("r1", events);

    const page = await adapter.getEvents("r1", { offset: 1, limit: 2 });
    expect(page.length).toBe(2);
    expect(page[0]!.type).toBe("step:started");
    expect(page[1]!.type).toBe("llm:done");
  });

  it("getEvents returns empty array for unknown run", async () => {
    const adapter = new InMemoryAdapter();
    const events = await adapter.getEvents("nonexistent");
    expect(events).toEqual([]);
  });

  it("listRuns returns all states when no filter", async () => {
    const adapter = new InMemoryAdapter();
    await adapter.saveState(createTestState("r1", { status: "ready" }));
    await adapter.saveState(createTestState("r2", { status: "running" }));
    await adapter.saveState(createTestState("r3", { status: "completed" }));

    const runs = await adapter.listRuns();
    expect(runs.length).toBe(3);
  });

  it("listRuns filters by status", async () => {
    const adapter = new InMemoryAdapter();
    await adapter.saveState(createTestState("r1", { status: "ready" }));
    await adapter.saveState(createTestState("r2", { status: "running" }));
    await adapter.saveState(createTestState("r3", { status: "running" }));

    const runningRuns = await adapter.listRuns({ status: "running" });
    expect(runningRuns.length).toBe(2);
    expect(runningRuns.every(r => r.status === "running")).toBe(true);
  });

  it("deleteRun removes state and events", async () => {
    const adapter = new InMemoryAdapter();
    await adapter.saveState(createTestState("r1"));
    await adapter.appendEvents("r1", [{ type: "run:started" as const, runId: "r1", model: "test", systemPrompt: "Hi", tools: [], maxSteps: 10 }]);

    await adapter.deleteRun("r1");

    const state = await adapter.loadState("r1");
    expect(state).toBeNull();

    const events = await adapter.getEvents("r1");
    expect(events).toEqual([]);
  });

  it("acquirePendingRuns picks up ready runs", async () => {
    const adapter = new InMemoryAdapter();
    await adapter.saveState(createTestState("r1", { status: "ready" }));
    await adapter.saveState(createTestState("r2", { status: "ready" }));
    await adapter.saveState(createTestState("r3", { status: "completed" }));

    const acquired = await adapter.acquirePendingRuns({
      statuses: ["ready", "running"],
      workerId: "worker-1",
      leaseTtlMs: 30000,
      batchSize: 10,
    });

    expect(acquired.length).toBe(2);
    expect(acquired.every(r => r.status === "running")).toBe(true);
  });

  it("renewLease returns true for matching worker", async () => {
    const adapter = new InMemoryAdapter();
    await adapter.saveState(createTestState("r1", { status: "ready" }));
    await adapter.acquirePendingRuns({
      statuses: ["ready"],
      workerId: "worker-1",
      leaseTtlMs: 30000,
      batchSize: 1,
    });

    const renewed = await adapter.renewLease("r1", "worker-1", 30000);
    expect(renewed).toBe(true);
  });

  it("renewLease returns false for non-matching worker", async () => {
    const adapter = new InMemoryAdapter();
    await adapter.saveState(createTestState("r1", { status: "ready" }));
    await adapter.acquirePendingRuns({
      statuses: ["ready"],
      workerId: "worker-1",
      leaseTtlMs: 30000,
      batchSize: 1,
    });

    const renewed = await adapter.renewLease("r1", "worker-2", 30000);
    expect(renewed).toBe(false);
  });

  it("releaseLease removes lease for matching worker", async () => {
    const adapter = new InMemoryAdapter();
    await adapter.saveState(createTestState("r1", { status: "ready" }));
    await adapter.acquirePendingRuns({
      statuses: ["ready"],
      workerId: "worker-1",
      leaseTtlMs: 30000,
      batchSize: 1,
    });

    await adapter.releaseLease("r1", "worker-1");

    const lease = await adapter.getLease("r1");
    expect(lease).toBeNull();
  });

  it("getLease returns lease info", async () => {
    const adapter = new InMemoryAdapter();
    await adapter.saveState(createTestState("r1", { status: "ready" }));
    await adapter.acquirePendingRuns({
      statuses: ["ready"],
      workerId: "worker-1",
      leaseTtlMs: 30000,
      batchSize: 1,
    });

    const lease = await adapter.getLease("r1");
    expect(lease).not.toBeNull();
    expect(lease!.workerId).toBe("worker-1");
    expect(lease!.lockedAt).toBeTypeOf("number");
  });

  it("acquirePendingRuns respects batchSize limit", async () => {
    const adapter = new InMemoryAdapter();
    for (let i = 0; i < 5; i++) {
      await adapter.saveState(createTestState(`r${i}`, { status: "ready" }));
    }

    const acquired = await adapter.acquirePendingRuns({
      statuses: ["ready"],
      workerId: "worker-1",
      leaseTtlMs: 30000,
      batchSize: 2,
    });

    expect(acquired.length).toBe(2);
  });
});
