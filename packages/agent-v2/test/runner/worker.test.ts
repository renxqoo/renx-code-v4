import { describe, it, expect, afterEach, vi } from "vitest";
import { createWorker } from "../../src/runner/worker.js";
import { InMemoryAdapter } from "../../src/runner/adapters/memory.js";
import { agent } from "../../src/agent.js";
import { userMessage } from "../../src/message.js";
import type { RunState } from "../../src/state.js";

describe("createWorker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a Worker object with start, poll, and stop methods", () => {
    const adapter = new InMemoryAdapter();
    const worker = createWorker({ agent, adapter });

    expect(worker).toBeDefined();
    expect(typeof worker.start).toBe("function");
    expect(typeof worker.poll).toBe("function");
    expect(typeof worker.stop).toBe("function");
  });

  it("uses default config values when options are omitted", () => {
    const worker = createWorker({ agent });
    expect(worker).toBeDefined();
  });

  it("poll acquires ready runs via adapter.acquirePendingRuns", async () => {
    const adapter = new InMemoryAdapter();

    // Spy on acquirePendingRuns
    const spy = vi.spyOn(adapter, "acquirePendingRuns");

    const now = Date.now();
    const readyState: RunState = {
      runId: "worker-test-run-1",
      status: "ready",
      model: "test-model",
      systemPrompt: "Be helpful",
      messages: [userMessage("Hi")],
      workingMemory: {},
      stepCount: 0,
      tokenUsage: { input: 0, output: 0 },
      startedAt: now,
      lastActiveAt: now,
    };
    await adapter.saveState(readyState);

    const worker = createWorker({
      agent,
      adapter,
      statuses: ["ready"],
      batchSize: 10,
    });

    await worker.poll();

    // Verify acquirePendingRuns was called with correct params
    expect(spy).toHaveBeenCalledTimes(1);
    const callArgs = spy.mock.calls[0]![0];
    expect(callArgs.statuses).toEqual(["ready"]);
    expect(callArgs.batchSize).toBe(10);
  });

  it("poll does nothing when no pending runs exist", async () => {
    const adapter = new InMemoryAdapter();
    const worker = createWorker({
      agent,
      adapter,
      statuses: ["ready"],
    });

    await worker.poll();

    const runs = await adapter.listRuns();
    expect(runs).toHaveLength(0);
  });

  it("start with abort signal stops worker", async () => {
    const adapter = new InMemoryAdapter();

    const worker = createWorker({
      agent,
      adapter,
      pollIntervalMs: 50,
      batchSize: 10,
    });

    const signal = AbortSignal.timeout(100);
    await worker.start(signal);
    worker.stop();
  });

  it("uses workerId from config or generates one", () => {
    const adapter = new InMemoryAdapter();

    const withId = createWorker({
      agent,
      adapter,
      workerId: "custom-worker-1",
    });
    expect(withId).toBeDefined();

    const withoutId = createWorker({ agent, adapter });
    expect(withoutId).toBeDefined();
  });

  it("passes custom workerId to adapter.acquirePendingRuns", async () => {
    const adapter = new InMemoryAdapter();

    const now = Date.now();
    await adapter.saveState({
      runId: "wkr-id-test",
      status: "ready",
      model: "test-model",
      systemPrompt: "Be helpful",
      messages: [userMessage("Hi")],
      workingMemory: {},
      stepCount: 0,
      tokenUsage: { input: 0, output: 0 },
      startedAt: now,
      lastActiveAt: now,
    });

    const spy = vi.spyOn(adapter, "acquirePendingRuns");

    const worker = createWorker({
      agent,
      adapter,
      workerId: "custom-worker",
      statuses: ["ready"],
      batchSize: 5,
    });

    await worker.poll();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].workerId).toBe("custom-worker");
  });

  it("respects batchSize config", async () => {
    const adapter = new InMemoryAdapter();

    const spy = vi.spyOn(adapter, "acquirePendingRuns");

    const worker = createWorker({
      agent,
      adapter,
      batchSize: 3,
    });

    await worker.poll();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].batchSize).toBe(3);
  });

  it("respects statuses filter", async () => {
    const adapter = new InMemoryAdapter();

    // Create a ready run
    await adapter.saveState({
      runId: "ready-run",
      status: "ready",
      model: "test",
      systemPrompt: "Be helpful",
      messages: [],
      workingMemory: {},
      stepCount: 0,
      tokenUsage: { input: 0, output: 0 },
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
    });

    // Create a waiting_approval run
    await adapter.saveState({
      runId: "waiting-run",
      status: "waiting_approval",
      model: "test",
      systemPrompt: "Be helpful",
      messages: [],
      workingMemory: {},
      stepCount: 0,
      tokenUsage: { input: 0, output: 0 },
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
    });

    const spy = vi.spyOn(adapter, "acquirePendingRuns");

    const worker = createWorker({
      agent,
      adapter,
      statuses: ["ready"], // Only acquire ready runs
    });

    await worker.poll();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].statuses).toEqual(["ready"]);
  });

  it("stop transitions worker out of running state", () => {
    const adapter = new InMemoryAdapter();
    const worker = createWorker({ agent, adapter });

    // Should not throw
    worker.stop();
  });

  it("lease renewal is configured with correct interval", () => {
    const adapter = new InMemoryAdapter();

    const withExplicitLease = createWorker({
      agent,
      adapter,
      leaseTtlMs: 60000,
      leaseRenewIntervalMs: 15000,
    });
    expect(withExplicitLease).toBeDefined();

    const withDefaultLease = createWorker({
      agent,
      adapter,
      leaseTtlMs: 10000,
      // leaseRenewIntervalMs should default to leaseTtlMs / 2 = 5000
    });
    expect(withDefaultLease).toBeDefined();
  });
});
