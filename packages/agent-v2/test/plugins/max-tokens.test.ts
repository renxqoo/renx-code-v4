import { describe, it, expect } from "vitest";
import { pipe } from "../../src/plugin.js";
import { withMaxTokens } from "../../src/plugins/max-tokens.js";
import type { AgentEvent } from "../../src/events.js";

describe("withMaxTokens", () => {
  it("allows normal completion when under token limit", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = async function* (): any {
      yield { type: "run:started", runId: "r1", model: "test", systemPrompt: "Hi", maxSteps: 10 };
      yield { type: "step:started", step: 1 };
      yield { type: "llm:done", step: 1, finishReason: "stop", text: "OK", usage: { input: 50, output: 30 } };
      yield { type: "step:completed", step: 1, finishReason: "stop", tokenUsage: { input: 50, output: 30 } };
      yield {
        type: "run:finished",
        outcome: { finishReason: "stop" as const, text: "OK", messages: [], workingMemory: {}, tokenUsage: { input: 50, output: 30 }, totalSteps: 1, runId: "r1" },
      };
    };

    const composed = pipe(withMaxTokens({ maxTotalTokens: 100 }), inner as any) as any;
    const events: AgentEvent[] = [];
    for await (const event of composed({} as any)) {
      events.push(event);
    }

    expect(events.some(e => e.type === "run:finished")).toBe(true);
    const finished = events.filter((e: any) => e.type === "run:finished").pop() as any;
    expect(finished.outcome.finishReason).toBe("stop");
  });

  it("stops the run when tokens exceed limit with onExceeded='stop'", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = async function* (): any {
      yield { type: "run:started", runId: "r1", model: "test", systemPrompt: "Hi", maxSteps: 10 };
      yield { type: "step:started", step: 1 };
      yield { type: "llm:done", step: 1, finishReason: "tool_calls", text: "", usage: { input: 120, output: 80 } };
      yield { type: "step:completed", step: 1, finishReason: "tool_calls", tokenUsage: { input: 120, output: 80 } };
    };

    const composed = pipe(withMaxTokens({ maxTotalTokens: 100, onExceeded: "stop" }), inner as any) as any;
    const events: AgentEvent[] = [];
    for await (const event of composed({} as any)) {
      events.push(event);
    }

    const finishedEvents = events.filter((e: any) => e.type === "run:finished") as any[];
    expect(finishedEvents.length).toBeGreaterThan(0);
    const lastFinished = finishedEvents[finishedEvents.length - 1];
    expect(lastFinished.outcome.finishReason).toBe("error");
  });

  it("continues when onExceeded is 'warn'", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = async function* (): any {
      yield { type: "run:started", runId: "r1", model: "test", systemPrompt: "Hi", maxSteps: 10 };
      yield { type: "step:started", step: 1 };
      yield { type: "llm:done", step: 1, finishReason: "stop", text: "OK", usage: { input: 200, output: 50 } };
      yield { type: "step:completed", step: 1, finishReason: "stop", tokenUsage: { input: 200, output: 50 } };
      yield {
        type: "run:finished",
        outcome: { finishReason: "stop" as const, text: "OK", messages: [], workingMemory: {}, tokenUsage: { input: 200, output: 50 }, totalSteps: 1, runId: "r1" },
      };
    };

    const composed = pipe(withMaxTokens({ maxTotalTokens: 100, onExceeded: "warn" }), inner as any) as any;
    const events: AgentEvent[] = [];
    for await (const event of composed({} as any)) {
      events.push(event);
    }

    const finishedEvents = events.filter((e: any) => e.type === "run:finished") as any[];
    expect(finishedEvents.length).toBe(1);
    expect(finishedEvents[0].outcome.finishReason).toBe("stop");
  });

  it("does not trigger when exactly at the limit", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = async function* (): any {
      yield { type: "run:started", runId: "r1", model: "test", systemPrompt: "Hi", maxSteps: 10 };
      yield { type: "step:started", step: 1 };
      yield { type: "llm:done", step: 1, finishReason: "stop", text: "OK", usage: { input: 50, output: 50 } };
      yield { type: "step:completed", step: 1, finishReason: "stop", tokenUsage: { input: 50, output: 50 } };
      yield {
        type: "run:finished",
        outcome: { finishReason: "stop" as const, text: "OK", messages: [], workingMemory: {}, tokenUsage: { input: 50, output: 50 }, totalSteps: 1, runId: "r1" },
      };
    };

    const composed = pipe(withMaxTokens({ maxTotalTokens: 100, onExceeded: "stop" }), inner as any) as any;
    const events: AgentEvent[] = [];
    for await (const event of composed({} as any)) {
      events.push(event);
    }

    const finishedEvents = events.filter((e: any) => e.type === "run:finished") as any[];
    expect(finishedEvents.length).toBe(1);
    expect(finishedEvents[0].outcome.finishReason).toBe("stop");
  });
});
