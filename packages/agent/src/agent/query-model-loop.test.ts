import { beforeEach, describe, expect, it, vi } from "vitest";
import { runQueryModelLoop } from "./query-model-loop";
import * as runtimeModule from "../model/runtime";
import type { RuntimeOutcome } from "../model/runtime";
import { ToolRegistry } from "../tools/registry";
import { createDefaultSandboxRegistry } from "../sandbox/default-registry";
import { DEFAULT_LLM_MAX_RETRIES } from "./llm-retry";
import type { CanonicalToolCall } from "@renx/provider";
import zod from "zod";
import { createPermissionHook } from "./hooks";

vi.mock("../model/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../model/runtime")>();
  return { ...actual, runtime: vi.fn() };
});

const runtime = vi.mocked(runtimeModule.runtime);

function okOutcome(): RuntimeOutcome {
  return {
    ok: true,
    textStream: (async function* () {})(),
    text: Promise.resolve("done"),
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

function toolCallsOutcome(calls: CanonicalToolCall[]): RuntimeOutcome {
  return {
    ok: true,
    textStream: (async function* () {})(),
    text: Promise.resolve(""),
    reasoning: Promise.resolve(""),
    toolCalls: Promise.resolve(calls),
    usage: Promise.resolve(undefined),
    finishReason: Promise.resolve("tool_calls"),
  };
}

const baseParams = {
  initial: {
    model: "x" as unknown as import("../domain/query-model").QueryModelType["model"],
    systemPrompt: "",
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
  },
  maxSteps: 5,
  registry: new ToolRegistry(),
  sandboxRegistry: createDefaultSandboxRegistry(),
};

describe("runQueryModelLoop", () => {
  beforeEach(() => {
    runtime.mockReset();
  });

  it(`defaults to ${DEFAULT_LLM_MAX_RETRIES} extra attempts and preserves managed status`, async () => {
    runtime
      .mockResolvedValueOnce(failOutcome())
      .mockResolvedValueOnce(failOutcome())
      .mockResolvedValueOnce(okOutcome());

    const out = await runQueryModelLoop(baseParams);

    expect(runtime).toHaveBeenCalledTimes(3);
    expect(out.status).toBe("finished");
    expect(out.error).toBeUndefined();
  });

  it("executes tools and finishes with trace-friendly messages", async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn().mockResolvedValue({
      success: true,
      content: "result",
      metadata: {},
    });
    registry.register({
      id: "read_file",
      name: "read_file",
      type: "read_only",
      schema: zod.object({ path: zod.string() }),
      execute,
    });

    runtime
      .mockResolvedValueOnce(
        toolCallsOutcome([{ id: "c1", name: "read_file", arguments: '{"path":"/tmp/test.txt"}' }]),
      )
      .mockResolvedValueOnce(okOutcome());

    const out = await runQueryModelLoop({ ...baseParams, registry });

    expect(out.status).toBe("finished");
    expect(execute).toHaveBeenCalledOnce();
    expect(out.messages.length).toBeGreaterThan(baseParams.initial.messages.length);
  });

  it("pauses for permission requests", async () => {
    const registry = new ToolRegistry();
    registry.register({
      id: "delete_file",
      name: "delete_file",
      type: "write_only",
      schema: zod.object({ path: zod.string() }),
      execute: vi.fn(),
    });

    runtime.mockResolvedValueOnce(
      toolCallsOutcome([{ id: "c1", name: "delete_file", arguments: '{"path":"/tmp/a"}' }]),
    );

    const out = await runQueryModelLoop({
      ...baseParams,
      registry,
      enterpriseHooks: [
        createPermissionHook({
          toolsRequiringConfirmation: ["delete_file"],
          confirm: async () => false,
          onReject: "pause",
          rejectReason: "blocked",
        }),
      ],
    });

    expect(out.status).toBe("waiting_permission");
    expect(out.stopReason).toBe("blocked");
    expect(out.pendingApproval?.invocations[0]?.name).toBe("delete_file");
  });
});
