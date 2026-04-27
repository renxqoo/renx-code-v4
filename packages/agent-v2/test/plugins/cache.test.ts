import { describe, it, expect } from "vitest";
import { pipe } from "../../src/plugin.js";
import { withCache, type CacheStore } from "../../src/plugins/cache.js";
import { agent } from "../../src/agent.js";
import { userMessage } from "../../src/message.js";
import type { AgentGenerator, AgentInput, AgentResult } from "../../src/index.js";
import type { AgentEvent } from "../../src/events.js";

class TestCacheStore implements CacheStore {
  private store = new Map<string, { result: AgentResult; expiresAt: number }>();

  async get(key: string): Promise<AgentResult | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.result;
  }

  async set(key: string, result: AgentResult, ttlMs: number): Promise<void> {
    this.store.set(key, { result, expiresAt: Date.now() + ttlMs });
  }
}

async function collectEvents(fn: (input: AgentInput) => AgentGenerator): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of fn({
    model: "test",
    systemPrompt: "Be helpful",
    messages: [userMessage("Hi")],
  } as AgentInput)) {
    events.push(event);
  }
  return events;
}

function lastEvent<T extends AgentEvent>(events: AgentEvent[], type: string): T | undefined {
  return events.filter((e) => e.type === type).pop() as T | undefined;
}

describe("withCache", () => {
  it("cache miss — runs agent and caches result on stop", async () => {
    const store = new TestCacheStore();
    let runCount = 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = async function* (): any {
      runCount++;
      yield { type: "run:started", runId: "r1", model: "test", systemPrompt: "Hi", maxSteps: 10 };
      yield { type: "step:started", step: 1 };
      yield { type: "llm:done", step: 1, finishReason: "stop", text: "Result", usage: { input: 5, output: 3 } };
      yield { type: "step:completed", step: 1, finishReason: "stop", tokenUsage: { input: 5, output: 3 } };
      yield {
        type: "run:finished",
        outcome: { finishReason: "stop" as const, text: "Result", messages: [], workingMemory: {}, tokenUsage: { input: 5, output: 3 }, totalSteps: 1, runId: "r1" },
      };
    };

    const events = await collectEvents(
      pipe(withCache({ store }), inner as any) as any,
    );

    expect(runCount).toBe(1);
    expect(events.some(e => e.type === "run:finished")).toBe(true);
  });

  it("cache hit — yields synthetic run:started + run:finished without running agent", async () => {
    const store = new TestCacheStore();

    const cachedResult: AgentResult = {
      finishReason: "stop",
      text: "Cached result",
      messages: [],
      workingMemory: {},
      tokenUsage: { input: 5, output: 3 },
      totalSteps: 1,
      runId: "cached-run",
    };
    await store.set("Be helpful|Hi", cachedResult, 60000);

    let runCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = async function* (): any {
      runCount++;
      yield { type: "run:finished", outcome: { finishReason: "stop" as const } };
    };

    const events = await collectEvents(
      pipe(withCache({ store }), inner as any) as any,
    );

    expect(runCount).toBe(0);
    const started = lastEvent<any>(events, "run:started");
    expect(started).toBeDefined();

    const finished = lastEvent<any>(events, "run:finished");
    expect(finished).toBeDefined();
    expect(finished.outcome.text).toBe("Cached result");
    expect(finished.outcome.finishReason).toBe("stop");
  });

  it("does not cache runs that end with error", async () => {
    const store = new TestCacheStore();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = async function* (): any {
      yield {
        type: "run:finished",
        outcome: {
          finishReason: "error" as const,
          text: "",
          messages: [],
          workingMemory: {},
          tokenUsage: { input: 5, output: 0 },
          totalSteps: 0,
          runId: "r1",
          error: { code: "LLM_UNAVAILABLE", message: "Fail", retryable: false },
        } as AgentResult,
      };
    };

    await collectEvents(
      pipe(withCache({ store }), inner as any) as any,
    );

    const cached = await store.get("Be helpful|Hi");
    expect(cached).toBeUndefined();
  });

  it("supports custom keyFn", async () => {
    const store = new TestCacheStore();

    const customKeyFn = (_input: AgentInput) => "custom-key";

    const cachedResult: AgentResult = {
      finishReason: "stop",
      text: "Custom key cached",
      messages: [],
      workingMemory: {},
      tokenUsage: { input: 1, output: 1 },
      totalSteps: 1,
      runId: "custom-run",
    };
    await store.set("custom-key", cachedResult, 60000);

    let runCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = async function* (): any {
      runCount++;
      yield { type: "run:finished", outcome: { finishReason: "stop" as const } };
    };

    const events = await collectEvents(
      pipe(withCache({ store, keyFn: customKeyFn }), inner as any) as any,
    );

    expect(runCount).toBe(0);
    const finished = lastEvent<any>(events, "run:finished");
    expect(finished.outcome.text).toBe("Custom key cached");
  });

  it("passes through events on cache miss", async () => {
    const store = new TestCacheStore();

    const events: AgentEvent[] = [];
    for await (const event of pipe(withCache({ store }), agent)({
      model: "test",
      systemPrompt: "Be helpful",
      messages: [userMessage("Hi")],
      llmClient: {
        stream: async function* () {
          yield { type: "text-delta" as const, delta: "Hello" };
          yield { type: "finish" as const, finishReason: "stop", usage: { input: 5, output: 3 } };
        },
      },
    })) {
      events.push(event);
    }

    expect(events.some(e => e.type === "run:started")).toBe(true);
    expect(events.some(e => e.type === "llm:delta")).toBe(true);
    expect(events.some(e => e.type === "run:finished")).toBe(true);

    const finished = lastEvent<any>(events, "run:finished");
    expect(finished.outcome.finishReason).toBe("stop");
  });

  it("subsequent call with same input hits cache", async () => {
    const store = new TestCacheStore();
    let runCount = 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = async function* (): any {
      runCount++;
      yield { type: "run:started", runId: "r1", model: "test", systemPrompt: "Hi", maxSteps: 10 };
      yield {
        type: "run:finished",
        outcome: { finishReason: "stop" as const, text: "First run", messages: [], workingMemory: {}, tokenUsage: { input: 5, output: 3 }, totalSteps: 1, runId: "r1" },
      };
    };

    const composed = pipe(withCache({ store }), inner as any) as any;

    await collectEvents(composed);
    expect(runCount).toBe(1);

    const events2 = await collectEvents(composed);
    expect(runCount).toBe(1);

    const finished = lastEvent<any>(events2, "run:finished");
    expect(finished.outcome.text).toBe("First run");
  });
});
