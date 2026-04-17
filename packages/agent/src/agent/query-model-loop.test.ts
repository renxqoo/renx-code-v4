import { describe, expect, it, vi, beforeEach } from "vitest";
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
    messages: [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "hi" }],
      },
    ],
  },
  maxSteps: 5,
  registry: new ToolRegistry(),
  sandboxRegistry: createDefaultSandboxRegistry(),
};

describe("runQueryModelLoop — model retry", () => {
  beforeEach(() => {
    runtime.mockReset();
  });

  it(`defaults to ${DEFAULT_LLM_MAX_RETRIES} extra attempts: recovers after failures`, async () => {
    runtime
      .mockResolvedValueOnce(failOutcome())
      .mockResolvedValueOnce(failOutcome())
      .mockResolvedValueOnce(okOutcome());

    const out = await runQueryModelLoop(baseParams);

    expect(runtime).toHaveBeenCalledTimes(3);
    expect(out.error).toBeUndefined();
    expect(out.finishReason).toBe("stop");
  });

  it("llmRetry maxRetries 0 disables retry", async () => {
    runtime.mockResolvedValueOnce(failOutcome());

    const out = await runQueryModelLoop({
      ...baseParams,
      llmRetry: { maxRetries: 0 },
    });

    expect(runtime).toHaveBeenCalledTimes(1);
    expect(out.error).toBeDefined();
  });

  it("isRetryable false does not consume retries", async () => {
    runtime.mockResolvedValueOnce(failOutcome());

    const isRetryable = vi.fn().mockReturnValue(false);
    await runQueryModelLoop({
      ...baseParams,
      llmRetry: { maxRetries: 2, isRetryable },
    });

    expect(runtime).toHaveBeenCalledTimes(1);
    expect(isRetryable).toHaveBeenCalledOnce();
  });

  it("isRetryable true retries until success", async () => {
    runtime.mockResolvedValueOnce(failOutcome()).mockResolvedValueOnce(okOutcome());

    const isRetryable = vi.fn().mockReturnValue(true);
    const out = await runQueryModelLoop({
      ...baseParams,
      llmRetry: { maxRetries: 2, isRetryable },
    });

    expect(runtime).toHaveBeenCalledTimes(2);
    expect(out.error).toBeUndefined();
    expect(isRetryable).toHaveBeenCalled();
  });
});

describe("runQueryModelLoop — tool execution", () => {
  beforeEach(() => {
    runtime.mockReset();
  });

  it("executes tool calls and continues the loop", async () => {
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

    const call: CanonicalToolCall = {
      id: "c1",
      name: "read_file",
      arguments: '{"path":"/tmp/test.txt"}',
    };

    runtime
      .mockResolvedValueOnce(toolCallsOutcome([call]))
      .mockResolvedValueOnce(okOutcome());

    const out = await runQueryModelLoop({ ...baseParams, registry });

    expect(runtime).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledOnce();
    expect(out.finishReason).toBe("stop");
    expect(out.messages.length).toBeGreaterThan(baseParams.initial.messages.length);
  });

  it("returns structured error when tool is not registered", async () => {
    const registry = new ToolRegistry();
    const call: CanonicalToolCall = {
      id: "c1",
      name: "unknown_tool",
      arguments: "{}",
    };
    runtime.mockResolvedValueOnce(toolCallsOutcome([call]));

    const out = await runQueryModelLoop({ ...baseParams, registry });
    expect(out.error).toBeInstanceOf(Error);
    expect((out.error as Error).message).toContain("Tool not registered");
    expect(out.finishReason).toBe("error");
  });
});

describe("runQueryModelLoop — maxSteps", () => {
  beforeEach(() => {
    runtime.mockReset();
  });

  it("stops when maxSteps is reached", async () => {
    // Each call returns tool_calls, so the loop would run forever without maxSteps
    const registry = new ToolRegistry();
    const execute = vi.fn().mockResolvedValue({
      success: true,
      content: "ok",
      metadata: {},
    });
    registry.register({
      id: "t",
      name: "t",
      type: "read_only",
      schema: zod.object({}),
      execute,
    });

    const call: CanonicalToolCall = { id: "c1", name: "t", arguments: "{}" };
    runtime.mockImplementation(() =>
      Promise.resolve(toolCallsOutcome([call])),
    );

    const out = await runQueryModelLoop({ ...baseParams, registry, maxSteps: 2 });

    expect(out.error).toBeDefined();
    expect(out.error).toBeInstanceOf(Error);
    expect((out.error as Error).message).toMatch(/maxSteps/);
    expect(runtime).toHaveBeenCalledTimes(2);
  });
});

describe("runQueryModelLoop — enterprise hooks", () => {
  beforeEach(() => {
    runtime.mockReset();
  });

  it("stops when a permission hook aborts the run", async () => {
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
          onReject: "abort",
          rejectReason: "blocked",
        }),
      ],
    });

    expect(out.stopped).toBe(true);
    expect(out.stopReason).toBe("blocked");
    expect(runtime).toHaveBeenCalledTimes(1);
  });
});

describe("runQueryModelLoop — parseToolCallArguments failure", () => {
  beforeEach(() => {
    runtime.mockReset();
  });

  it("logs warning and uses empty args on invalid JSON", async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn().mockResolvedValue({
      success: true,
      content: "ok",
      metadata: {},
    });
    registry.register({
      id: "t",
      name: "t",
      type: "read_only",
      schema: zod.object({}),
      execute,
    });

    const call: CanonicalToolCall = { id: "c1", name: "t", arguments: "not-json" };
    runtime
      .mockResolvedValueOnce(toolCallsOutcome([call]))
      .mockResolvedValueOnce(okOutcome());

    const warnSpy = vi.fn();
    const out = await runQueryModelLoop({
      ...baseParams,
      registry,
      logger: { debug: vi.fn(), info: vi.fn(), warn: warnSpy, error: vi.fn() },
    });

    expect(warnSpy).toHaveBeenCalledWith(
      "parseToolCallArguments failed",
      expect.objectContaining({ toolName: "t", callId: "c1" }),
    );
    expect(out.finishReason).toBe("stop");
  });
});
