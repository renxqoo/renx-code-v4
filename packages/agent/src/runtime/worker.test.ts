import { beforeEach, describe, expect, it, vi } from "vitest";
import zod from "zod";
import { AgentRuntime } from "./agent-runtime";
import { InMemorySessionStore } from "./session-store";
import { AgentWorker } from "./worker";
import { ToolRegistry } from "../tools/registry";
import { createDefaultSandboxRegistry } from "../sandbox/default-registry";
import * as runtimeModule from "../model/runtime";
import type { RuntimeOutcome } from "../model/runtime";

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

describe("AgentWorker", () => {
  beforeEach(() => {
    runtime.mockReset();
  });

  it("starts ready runs and releases leases after processing", async () => {
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

    const worker = new AgentWorker({
      runtime: agentRuntime,
      ownerId: "worker-a",
      pollIntervalMs: 0,
    });

    expect(await worker.runOnce()).toBe(1);
    expect((await agentRuntime.getRun(run.runId))?.status).toBe("finished");
    expect(await agentRuntime.getRunLease(run.runId)).toBeNull();
  });

  it("resumes running runs and skips waiting permission by default", async () => {
    runtime.mockResolvedValueOnce(toolCallsOutcome("delete_file")).mockResolvedValueOnce(okOutcome("done"));

    const registry = new ToolRegistry();
    registry.register({
      id: "delete_file",
      name: "delete_file",
      type: "write_only",
      schema: zod.object({}),
      execute: vi.fn().mockResolvedValue({ success: true, content: "deleted", metadata: {} }),
    });

    const store = new InMemorySessionStore();
    const agentRuntime = new AgentRuntime({
      maxSteps: 4,
      registry,
      sandboxRegistry: createDefaultSandboxRegistry(),
      sessionStore: store,
    });

    const resumableRun = await agentRuntime.createRun({
      model: "openai/gpt-4o-mini",
      systemPrompt: "Be concise.",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });
    await store.saveRun({
      ...(await agentRuntime.getRun(resumableRun.runId))!,
      status: "running",
    });

    const waitingRun = await agentRuntime.createRun({
      model: "openai/gpt-4o-mini",
      systemPrompt: "Be careful.",
      messages: [{ role: "user", content: [{ type: "text", text: "needs approval" }] }],
    });
    await store.saveRun({
      ...(await agentRuntime.getRun(waitingRun.runId))!,
      status: "waiting_permission",
    });

    const worker = new AgentWorker({
      runtime: agentRuntime,
      ownerId: "worker-b",
      pollIntervalMs: 0,
    });

    expect(await worker.runOnce()).toBe(1);
    expect((await agentRuntime.getRun(resumableRun.runId))?.status).toBe("finished");
    expect((await agentRuntime.getRun(waitingRun.runId))?.status).toBe("waiting_permission");
  });
});
