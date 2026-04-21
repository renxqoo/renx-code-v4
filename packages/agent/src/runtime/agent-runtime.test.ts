import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "./agent-runtime";
import { InMemorySessionStore } from "./session-store";
import * as runtimeModule from "../model/runtime";
import { ToolRegistry } from "../tools/registry";
import { createDefaultSandboxRegistry } from "../sandbox/default-registry";
import type { RuntimeOutcome } from "../model/runtime";
import zod from "zod";
import { createAuditHook, createPermissionHook } from "../agent/hooks";

vi.mock("../model/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../model/runtime")>();
  return { ...actual, runtime: vi.fn() };
});

const runtime = vi.mocked(runtimeModule.runtime);

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

function toolCallsOutcome(name: string): RuntimeOutcome {
  return {
    ok: true,
    textStream: (async function* () {})(),
    text: Promise.resolve(""),
    reasoning: Promise.resolve(""),
    toolCalls: Promise.resolve([{ id: "call-1", name, arguments: "{}" }]),
    usage: Promise.resolve(undefined),
    finishReason: Promise.resolve("tool_calls"),
  };
}

describe("AgentRuntime", () => {
  beforeEach(() => {
    runtime.mockReset();
  });

  it("creates a managed run, executes it, and records trace events", async () => {
    runtime.mockResolvedValue(okOutcome());

    const store = new InMemorySessionStore();
    const agentRuntime = new AgentRuntime({
      maxSteps: 3,
      registry: new ToolRegistry(),
      sandboxRegistry: createDefaultSandboxRegistry(),
      sessionStore: store,
    });

    const run = await agentRuntime.createRun({
      model: "openai/gpt-4o-mini",
      systemPrompt: "Be concise.",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });

    const out = await agentRuntime.startRun(run.runId);
    const storedRun = await agentRuntime.getRun(run.runId);
    const trace = await agentRuntime.getRunTrace(run.runId);

    expect(out.runId).toBe(run.runId);
    expect(out.status).toBe("finished");
    expect(storedRun?.status).toBe("finished");
    expect(trace.map((event) => event.type)).toEqual(
      expect.arrayContaining(["run_created", "run_started", "step_started", "model_completed", "run_finished"]),
    );
  });

  it("supports sliced event replay for resumable traces", async () => {
    runtime.mockResolvedValue(okOutcome());

    const agentRuntime = new AgentRuntime({
      maxSteps: 3,
      registry: new ToolRegistry(),
      sandboxRegistry: createDefaultSandboxRegistry(),
      sessionStore: new InMemorySessionStore(),
    });

    const run = await agentRuntime.createRun({
      model: "openai/gpt-4o-mini",
      systemPrompt: "Be concise.",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });

    await agentRuntime.startRun(run.runId);
    const fullTrace = await agentRuntime.getRunTrace(run.runId);
    const slicedTrace = await agentRuntime.getRunTrace(run.runId, { offset: 1, limit: 2 });

    expect(slicedTrace).toEqual(fullTrace.slice(1, 3));
  });

  it("lists runs and coordinates leases for worker handoff", async () => {
    runtime.mockResolvedValue(okOutcome());

    const store = new InMemorySessionStore();
    const agentRuntime = new AgentRuntime({
      maxSteps: 3,
      registry: new ToolRegistry(),
      sandboxRegistry: createDefaultSandboxRegistry(),
      sessionStore: store,
    });

    const first = await agentRuntime.createRun({
      model: "openai/gpt-4o-mini",
      systemPrompt: "Be concise.",
      messages: [{ role: "user", content: [{ type: "text", text: "first" }] }],
    });
    const second = await agentRuntime.createRun({
      model: "openai/gpt-4o-mini",
      systemPrompt: "Be concise.",
      messages: [{ role: "user", content: [{ type: "text", text: "second" }] }],
    });
    await agentRuntime.startRun(first.runId);

    const readyRuns = await agentRuntime.listRuns({ statuses: ["ready"] });
    expect(readyRuns.map((run) => run.runId)).toEqual([second.runId]);

    const lease = await agentRuntime.acquireRunLease(second.runId, "worker-a", 1_000);
    expect(lease?.ownerId).toBe("worker-a");
    expect(await agentRuntime.acquireRunLease(second.runId, "worker-b", 1_000)).toBeNull();
    expect((await agentRuntime.renewRunLease(second.runId, "worker-a", 1_000))?.ownerId).toBe("worker-a");

    await agentRuntime.releaseRunLease(second.runId, "worker-a");
    expect(await agentRuntime.getRunLease(second.runId)).toBeNull();
  });

  it("pauses for permission and can resume the same run", async () => {
    runtime.mockResolvedValueOnce(toolCallsOutcome("delete_file")).mockResolvedValueOnce(okOutcome("finished"));

    const registry = new ToolRegistry();
    registry.register({
      id: "delete_file",
      name: "delete_file",
      type: "write_only",
      schema: zod.object({}),
      execute: vi.fn().mockResolvedValue({ success: true, content: "deleted", metadata: {} }),
    });

    let approved = false;
    const agentRuntime = new AgentRuntime({
      maxSteps: 4,
      registry,
      sandboxRegistry: createDefaultSandboxRegistry(),
      hooks: [
        createPermissionHook({
          toolsRequiringConfirmation: ["delete_file"],
          confirm: async () => approved,
          onReject: "pause",
          rejectReason: "awaiting-approval",
        }),
      ],
    });

    const run = await agentRuntime.createRun({
      model: "openai/gpt-4o-mini",
      systemPrompt: "Be careful.",
      messages: [{ role: "user", content: [{ type: "text", text: "delete the file" }] }],
    });

    const paused = await agentRuntime.startRun(run.runId);
    expect(paused.status).toBe("waiting_permission");
    expect(paused.pendingApproval?.invocations).toHaveLength(1);

    approved = true;
    const resumed = await agentRuntime.resumeRun(run.runId, { clearPendingApproval: true });
    expect(resumed.status).toBe("finished");
    expect(runtime).toHaveBeenCalledTimes(2);
  });

  it("emits enterprise audit events across model and tool phases", async () => {
    runtime.mockResolvedValueOnce(toolCallsOutcome("read_file")).mockResolvedValueOnce(okOutcome("done"));

    const registry = new ToolRegistry();
    registry.register({
      id: "read_file",
      name: "read_file",
      type: "read_only",
      schema: zod.object({}),
      execute: vi.fn().mockResolvedValue({ success: true, content: "contents", metadata: {} }),
    });

    const sink = vi.fn();
    const agentRuntime = new AgentRuntime({
      maxSteps: 4,
      registry,
      sandboxRegistry: createDefaultSandboxRegistry(),
      hooks: [createAuditHook({ sink })],
    });

    const outcome = await agentRuntime.run({
      model: "openai/gpt-4o-mini",
      systemPrompt: "Use tools when needed.",
      messages: [{ role: "user", content: [{ type: "text", text: "read the file" }] }],
    });

    expect(outcome.status).toBe("finished");
    expect(sink.mock.calls.map(([event]) => event.type)).toEqual(
      expect.arrayContaining([
        "run_started",
        "step_started",
        "model_started",
        "model_completed",
        "tool_authorization_requested",
        "tool_authorization_resolved",
        "tool_completed",
        "run_finished",
      ]),
    );
  });

  it("captures telemetry for run, model, tool, and lease lifecycle", async () => {
    runtime.mockResolvedValueOnce(toolCallsOutcome("read_file")).mockResolvedValueOnce(okOutcome("done"));

    const registry = new ToolRegistry();
    registry.register({
      id: "read_file",
      name: "read_file",
      type: "read_only",
      schema: zod.object({}),
      execute: vi.fn().mockResolvedValue({ success: true, content: "contents", metadata: {} }),
    });

    const events: string[] = [];
    const agentRuntime = new AgentRuntime({
      maxSteps: 4,
      registry,
      sandboxRegistry: createDefaultSandboxRegistry(),
      telemetry: {
        capture(event) {
          events.push(event.name);
        },
      },
    });

    const run = await agentRuntime.createRun({
      model: "openai/gpt-4o-mini",
      systemPrompt: "Use tools when needed.",
      messages: [{ role: "user", content: [{ type: "text", text: "read the file" }] }],
    });

    const lease = await agentRuntime.acquireRunLease(run.runId, "worker-a", 10_000);
    expect(lease?.ownerId).toBe("worker-a");
    await agentRuntime.startRun(run.runId);
    await agentRuntime.releaseRunLease(run.runId, "worker-a");

    expect(events).toEqual(
      expect.arrayContaining([
        "run_created",
        "lease_acquired",
        "run_started",
        "model_completed",
        "tool_completed",
        "run_finished",
        "lease_released",
      ]),
    );
  });
});
