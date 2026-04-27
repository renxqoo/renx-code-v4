import { beforeEach, describe, expect, it, vi } from "vitest";
import * as runtimeModule from "../model/runtime";
import type { RuntimeOutcome } from "../model/runtime";
import { ToolRegistry } from "../tools/registry";
import { ReActLoopEngine } from "./react-loop-engine";
import type { AgentRunRecord } from "./session-store";
import { createDefaultRunProfile, mergeRunProfile } from "../agent/hooks";

vi.mock("../model/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../model/runtime")>();
  return { ...actual, runtime: vi.fn() };
});

const runtime = vi.mocked(runtimeModule.runtime);

function buildRun(): AgentRunRecord {
  return {
    runId: "run-1",
    status: "running",
    maxSteps: 4,
    llmRounds: 1,
    initial: {
      model: "openai/gpt-4o-mini",
      systemPrompt: "Be concise.",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    },
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
  };
}

function okOutcome(text = "done"): RuntimeOutcome {
  return {
    ok: true,
    textStream: (async function* () {})(),
    text: Promise.resolve(text),
    reasoning: Promise.resolve(""),
    toolCalls: Promise.resolve([]),
    usage: Promise.resolve(undefined),
    finishReason: Promise.resolve("stop"),
  };
}

function failOutcome(): RuntimeOutcome {
  return {
    ok: false,
    error: new Error("transient"),
    textStream: (async function* () {})(),
    text: Promise.resolve(""),
    reasoning: Promise.resolve(""),
    toolCalls: Promise.resolve([]),
    usage: Promise.resolve(undefined),
    finishReason: Promise.resolve("error"),
  };
}

describe("ReActLoopEngine", () => {
  beforeEach(() => {
    runtime.mockReset();
  });

  it("retries failed model calls and returns the routed final decision", async () => {
    runtime.mockResolvedValueOnce(failOutcome()).mockResolvedValueOnce(okOutcome("finished"));

    const eventTypes: string[] = [];
    const telemetryNames: string[] = [];
    const pushedEventTypes: string[] = [];
    const engine = new ReActLoopEngine({
      registry: new ToolRegistry(),
      llmRetry: { maxRetries: 2 },
      contextBuilder: {
        async build(input) {
          return {
            ...input.run.initial,
            messages: input.run.messages,
          };
        },
      },
      emitEvent: async (event) => {
        eventTypes.push(event.type);
      },
      pushEvents: async (events) => {
        pushedEventTypes.push(...events.map((event) => event.type));
      },
      captureTelemetry: async (event) => {
        telemetryNames.push(event.name);
      },
    });

    const result = await engine.executeStep({
      run: buildRun(),
      llmRound: 1,
      messages: buildRun().messages,
      profile: createDefaultRunProfile(),
      retryRemaining: 2,
      retryDelayAttemptIndex: 0,
    });

    expect(runtime).toHaveBeenCalledTimes(2);
    expect(result.decision.type).toBe("final_answer");
    expect(result.retryRemaining).toBe(1);
    expect(result.retryDelayAttemptIndex).toBe(1);
    expect(eventTypes).toEqual(["model_started", "model_completed", "model_started", "model_completed"]);
    expect(pushedEventTypes).toEqual(["model_completed", "model_completed"]);
    expect(telemetryNames).toEqual(["model_completed", "model_completed"]);
  });

  it("forwards stream chunks with the run profile suppression flag", async () => {
    runtime.mockResolvedValueOnce({
      ok: true,
      textStream: (async function* () {
        yield { type: "text-delta", textDelta: "hi" };
      })(),
      text: Promise.resolve("hi"),
      reasoning: Promise.resolve(""),
      toolCalls: Promise.resolve([]),
      usage: Promise.resolve(undefined),
      finishReason: Promise.resolve("stop"),
    });

    const onStreamChunk = vi.fn();
    const engine = new ReActLoopEngine({
      registry: new ToolRegistry(),
      hooks: { onStreamChunk },
      contextBuilder: {
        async build(input) {
          return {
            ...input.run.initial,
            messages: input.run.messages,
          };
        },
      },
    });

    const result = await engine.executeStep({
      run: buildRun(),
      llmRound: 2,
      messages: buildRun().messages,
      profile: mergeRunProfile(createDefaultRunProfile(), { suppressStreaming: true }),
    });

    expect(result.decision.type).toBe("final_answer");
    expect(onStreamChunk).toHaveBeenCalledWith(
      { type: "text-delta", textDelta: "hi" },
      { llmRound: 2, suppressOutput: true },
    );
  });
});
