import { describe, expect, it } from "vitest";
import type { QueryModelOutcome } from "../agent/types";
import type { QueryModelType } from "../domain/query-model";
import type { AgentRunRecord } from "./session-store";
import { RunStateMachine } from "./run-state-machine";

const initial: QueryModelType = {
  model: "openai/gpt-4o-mini",
  systemPrompt: "Be concise.",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
};

function buildRun(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    runId: "run-1",
    status: "ready",
    maxSteps: 4,
    llmRounds: 0,
    initial,
    messages: [...initial.messages],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function buildOutcome(overrides: Partial<QueryModelOutcome> = {}): QueryModelOutcome {
  return {
    runId: "run-1",
    status: "finished",
    messages: [...initial.messages],
    finishReason: "stop",
    llmRounds: 1,
    lastStream: {
      ok: true,
      textStream: (async function* () {})(),
      text: Promise.resolve("done"),
      reasoning: Promise.resolve(""),
      toolCalls: Promise.resolve([]),
      usage: Promise.resolve(undefined),
      finishReason: Promise.resolve("stop"),
    },
    ...overrides,
  };
}

describe("RunStateMachine", () => {
  it("preserves pending approval on resume unless explicitly cleared", () => {
    const stateMachine = new RunStateMachine({
      now: () => "2026-01-01T00:00:01.000Z",
      createRunId: () => "run-1",
    });
    const pendingApproval = {
      invocations: [{ callId: "call-1", name: "delete_file", args: {} }],
      reason: "needs approval",
      requestedAt: "2026-01-01T00:00:00.000Z",
    };
    const run = buildRun({
      status: "waiting_permission",
      pendingApproval,
    });

    const preserved = stateMachine.resume(run);
    const cleared = stateMachine.resume(run, { clearPendingApproval: true });

    expect(preserved.run.pendingApproval).toEqual(pendingApproval);
    expect(cleared.run.pendingApproval).toBeUndefined();
  });

  it("rejects starting waiting runs directly", () => {
    const stateMachine = new RunStateMachine();
    const run = buildRun({ status: "waiting_permission" });

    expect(() => stateMachine.start(run)).toThrow(/resumeRun/);
  });

  it("materializes waiting input state as a run_waiting event", () => {
    const stateMachine = new RunStateMachine({
      now: () => "2026-01-01T00:00:02.000Z",
    });
    const run = buildRun({ status: "running" });
    const transition = stateMachine.complete(
      run,
      buildOutcome({
        status: "waiting_input",
        stopReason: "Need a file path.",
      }),
    );

    expect(transition.run.pendingInput).toEqual({
      reason: "Need a file path.",
      requestedAt: "2026-01-01T00:00:02.000Z",
    });
    expect(transition.events).toEqual([
      {
        type: "run_waiting",
        runId: "run-1",
        at: "2026-01-01T00:00:02.000Z",
        status: "waiting_input",
        reason: "Need a file path.",
        pendingInput: {
          reason: "Need a file path.",
          requestedAt: "2026-01-01T00:00:02.000Z",
        },
      },
    ]);
  });
});
