import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { FileSystemAdapter } from "../../../src/runner/adapters/filesystem.js";
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

describe("FileSystemAdapter", () => {
  let tmpDir: string;
  let adapter: FileSystemAdapter;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `agent-v2-fs-test-${Date.now()}`);
    adapter = new FileSystemAdapter(tmpDir);
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // cleanup failure is OK
    }
  });

  it("saveState writes and loadState reads correctly", async () => {
    const state = createTestState("r1", { status: "running", stepCount: 5 });
    await adapter.saveState(state);

    const loaded = await adapter.loadState("r1");
    expect(loaded).not.toBeNull();
    expect(loaded!.runId).toBe("r1");
    expect(loaded!.status).toBe("running");
    expect(loaded!.stepCount).toBe(5);
  });

  it("loadState returns null for non-existent run", async () => {
    const result = await adapter.loadState("nonexistent");
    expect(result).toBeNull();
  });

  it("appendEvents writes and getEvents reads events", async () => {
    const events = [
      { type: "run:started" as const, runId: "r1", model: "test", systemPrompt: "Hi", tools: [], maxSteps: 10 },
      { type: "llm:delta" as const, step: 1, delta: "Hello" },
      { type: "run:finished" as const, outcome: { finishReason: "stop" as const, text: "OK", messages: [], workingMemory: {}, tokenUsage: { input: 5, output: 3 }, totalSteps: 1, runId: "r1" } },
    ];

    await adapter.appendEvents("r1", events);
    const retrieved = await adapter.getEvents("r1");

    expect(retrieved.length).toBe(3);
    expect(retrieved[0]!.type).toBe("run:started");
    expect(retrieved[1]!.type).toBe("llm:delta");
    expect(retrieved[2]!.type).toBe("run:finished");
  });

  it("getEvents supports offset and limit", async () => {
    const events = [
      { type: "step:started" as const, step: 1 },
      { type: "llm:delta" as const, step: 1, delta: "A" },
      { type: "llm:delta" as const, step: 1, delta: "B" },
      { type: "llm:done" as const, step: 1, finishReason: "stop", text: "", usage: { input: 5, output: 3 } },
      { type: "step:completed" as const, step: 1, finishReason: "stop", tokenUsage: { input: 5, output: 3 } },
    ];
    await adapter.appendEvents("r1", events);

    const page = await adapter.getEvents("r1", { offset: 1, limit: 2 });
    expect(page.length).toBe(2);
    expect(page[0]!.type).toBe("llm:delta");
    expect(page[1]!.type).toBe("llm:delta");
  });

  it("getEvents returns empty array for non-existent run", async () => {
    const events = await adapter.getEvents("nonexistent");
    expect(events).toEqual([]);
  });

  it("listRuns returns all persisted runs", async () => {
    await adapter.saveState(createTestState("r1", { status: "ready" }));
    await adapter.saveState(createTestState("r2", { status: "completed" }));

    const runs = await adapter.listRuns();
    expect(runs.length).toBe(2);
  });

  it("listRuns filters by status", async () => {
    await adapter.saveState(createTestState("r1", { status: "ready" }));
    await adapter.saveState(createTestState("r2", { status: "running" }));

    const readyRuns = await adapter.listRuns({ status: "ready" });
    expect(readyRuns.length).toBe(1);
    expect(readyRuns[0]!.runId).toBe("r1");
  });

  it("deleteRun removes state directory", async () => {
    await adapter.saveState(createTestState("r1"));
    await adapter.appendEvents("r1", [{ type: "run:started" as const, runId: "r1", model: "test", systemPrompt: "Hi", tools: [], maxSteps: 10 }]);

    await adapter.deleteRun("r1");

    const state = await adapter.loadState("r1");
    expect(state).toBeNull();

    const events = await adapter.getEvents("r1");
    expect(events).toEqual([]);
  });

  it("loadState handles corrupted JSON gracefully", async () => {
    const dir = path.join(tmpDir, "bad-run");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "state.json"), "not valid json", "utf-8");

    await expect(adapter.loadState("bad-run")).rejects.toThrow();
  });

  it("acquirePendingRuns returns empty (not concurrent-safe)", async () => {
    await adapter.saveState(createTestState("r1", { status: "ready" }));

    const acquired = await adapter.acquirePendingRuns({
      statuses: ["ready"],
      workerId: "worker-1",
      leaseTtlMs: 30000,
      batchSize: 10,
    });

    expect(acquired).toEqual([]);
  });

  it("renewLease returns false (not concurrent-safe)", async () => {
    const result = await adapter.renewLease("r1", "w1", 30000);
    expect(result).toBe(false);
  });

  it("getLease returns null (not concurrent-safe)", async () => {
    const lease = await adapter.getLease("r1");
    expect(lease).toBeNull();
  });

  it("multiple saveState calls overwrite correctly", async () => {
    const state1 = createTestState("r1", { status: "ready", stepCount: 0 });
    const state2 = createTestState("r1", { status: "running", stepCount: 3 });

    await adapter.saveState(state1);
    await adapter.saveState(state2);

    const loaded = await adapter.loadState("r1");
    expect(loaded!.status).toBe("running");
    expect(loaded!.stepCount).toBe(3);
  });
});
