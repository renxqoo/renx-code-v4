import { describe, it, expect } from "vitest";
import { pipe } from "../../src/plugin.js";
import { withRetry } from "../../src/plugins/retry.js";
import { createAgentError } from "../../src/errors.js";
import type { AgentGenerator, AgentInput } from "../../src/index.js";
import type { AgentEvent } from "../../src/events.js";

async function runAndCollect(fn: (input: AgentInput) => AgentGenerator): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of fn({
    model: "test",
    systemPrompt: "Be helpful",
    messages: [{ role: "user", content: "Hi" }],
  } as AgentInput)) {
    events.push(event);
  }
  return events;
}

describe("withRetry", () => {
  it("does not retry on a successful run", async () => {
    let callCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = async function* (): any {
      callCount++;
      yield { type: "run:started", runId: "r1", model: "test", systemPrompt: "Hi", maxSteps: 10 };
      yield {
        type: "run:finished",
        outcome: { finishReason: "stop" as const, text: "OK", messages: [], workingMemory: {}, tokenUsage: { input: 0, output: 0 }, totalSteps: 1, runId: "r1" },
      };
    };

    const events = await runAndCollect(
      pipe(withRetry({ maxRetries: 2 }), inner as any) as any,
    );

    expect(callCount).toBe(1);
    expect(events.some((e) => e.type === "run:finished")).toBe(true);
  });

  it("retries on retryable llm:done error", async () => {
    let callCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = async function* (): any {
      callCount++;
      if (callCount < 3) {
        yield {
          type: "llm:done",
          step: 1,
          finishReason: "error",
          text: null,
          usage: { input: 5, output: 0 },
          error: createAgentError("LLM_UNAVAILABLE", "Transient error", true),
        };
        yield {
          type: "run:finished",
          outcome: { finishReason: "error" as const, error: createAgentError("LLM_UNAVAILABLE", "Transient error", true), messages: [], text: "", workingMemory: {}, tokenUsage: { input: 5, output: 0 }, totalSteps: 1, runId: "r1" },
        };
      } else {
        yield { type: "run:started", runId: "r1", model: "test", systemPrompt: "Hi", maxSteps: 10 };
        yield {
          type: "run:finished",
          outcome: { finishReason: "stop" as const, text: "OK", messages: [], workingMemory: {}, tokenUsage: { input: 5, output: 3 }, totalSteps: 1, runId: "r1" },
        };
      }
    };

    const events = await runAndCollect(
      pipe(withRetry({ maxRetries: 2 }), inner as any) as any,
    );

    expect(callCount).toBe(3);
    const finished = events.filter((e) => e.type === "run:finished");
    expect(finished.length).toBe(1);
    expect((finished[0] as any).outcome.finishReason).toBe("stop");
  });

  it("retries on retryable run:finished error", async () => {
    let callCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = async function* (): any {
      callCount++;
      if (callCount < 2) {
        yield {
          type: "run:finished",
          outcome: {
            finishReason: "error" as const,
            error: createAgentError("LLM_UNAVAILABLE", "Rate limited", true),
            messages: [], text: "", workingMemory: {},
            tokenUsage: { input: 5, output: 0 }, totalSteps: 0, runId: "r1",
          },
        };
      } else {
        yield {
          type: "run:finished",
          outcome: { finishReason: "stop" as const, text: "OK", messages: [], workingMemory: {}, tokenUsage: { input: 5, output: 3 }, totalSteps: 1, runId: "r1" },
        };
      }
    };

    await runAndCollect(
      pipe(withRetry({ maxRetries: 1 }), inner as any) as any,
    );

    expect(callCount).toBe(2);
  });

  it("respects maxRetries and yields the last attempt even if retryable", async () => {
    let callCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = async function* (): any {
      callCount++;
      yield {
        type: "run:finished",
        outcome: {
          finishReason: "error" as const,
          error: createAgentError("LLM_UNAVAILABLE", "Always fails", true),
          messages: [], text: "", workingMemory: {},
          tokenUsage: { input: 5, output: 0 }, totalSteps: 0, runId: "r1",
        },
      };
    };

    const events = await runAndCollect(
      pipe(withRetry({ maxRetries: 1 }), inner as any) as any,
    );

    expect(callCount).toBe(2);
    const finished = events.filter((e) => e.type === "run:finished");
    expect(finished.length).toBe(1);
    expect((finished[0] as any).outcome.finishReason).toBe("error");
  });

  it("does not retry non-retryable errors", async () => {
    let callCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = async function* (): any {
      callCount++;
      yield {
        type: "run:finished",
        outcome: {
          finishReason: "error" as const,
          error: createAgentError("INVALID_STATE", "Not retryable", false),
          messages: [], text: "", workingMemory: {},
          tokenUsage: { input: 5, output: 0 }, totalSteps: 0, runId: "r1",
        },
      };
    };

    await runAndCollect(
      pipe(withRetry({ maxRetries: 2 }), inner as any) as any,
    );

    expect(callCount).toBe(1);
  });

  it("respects custom isRetryable function", async () => {
    let callCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = async function* (): any {
      callCount++;
      yield {
        type: "run:finished",
        outcome: {
          finishReason: "stop" as const,
          text: "OK",
          messages: [], workingMemory: {},
          tokenUsage: { input: 5, output: 3 }, totalSteps: 1, runId: "r1",
        },
      };
    };

    await runAndCollect(
      pipe(withRetry({
        maxRetries: 1,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        isRetryable: (e: any) => e.type === "run:finished" && e.outcome.finishReason === "stop",
      }), inner as any) as any,
    );

    expect(callCount).toBe(2);
  });

  it("yields events from the successful attempt (not failed ones)", async () => {
    let callCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner = async function* (): any {
      callCount++;
      if (callCount === 1) {
        yield {
          type: "run:finished",
          outcome: {
            finishReason: "error" as const,
            error: createAgentError("LLM_UNAVAILABLE", "Fail", true),
            messages: [{ role: "assistant", content: "failed" }],
            text: "failed text", workingMemory: {},
            tokenUsage: { input: 5, output: 0 }, totalSteps: 0, runId: "r1",
          },
        };
      } else {
        yield {
          type: "run:finished",
          outcome: {
            finishReason: "stop" as const, text: "success", messages: [],
            workingMemory: {}, tokenUsage: { input: 5, output: 3 }, totalSteps: 1, runId: "r1",
          },
        };
      }
    };

    const events = await runAndCollect(
      pipe(withRetry({ maxRetries: 1 }), inner as any) as any,
    );

    const finished = events.filter((e) => e.type === "run:finished");
    expect(finished.length).toBe(1);
    expect((finished[0] as any).outcome.text).toBe("success");
  });
});
