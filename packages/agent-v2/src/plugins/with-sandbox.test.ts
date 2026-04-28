import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { wrapTool, withSandbox } from "./with-sandbox.js";
import type { SandboxExecutor } from "./with-sandbox.js";
import type { Tool } from "../tool.js";

function makeSandbox(overrides: Partial<SandboxExecutor> = {}): SandboxExecutor {
  return {
    id: "test-sandbox",
    execute: vi.fn().mockResolvedValue({
      success: true,
      content: "sandbox-ok",
      metadata: {},
    }),
    ...overrides,
  };
}

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: "test_tool",
    description: "A test tool",
    parameters: z.object({ x: z.number().optional(), code: z.string().optional() }),
    execute: vi.fn().mockResolvedValue("local-result"),
    ...overrides,
  };
}

describe("wrapTool", () => {
  it("routes execute() through the sandbox backend", async () => {
    const sandbox = makeSandbox({
      execute: vi.fn().mockResolvedValue({
        success: true,
        content: "42",
        metadata: {},
      }),
    });
    const tool = makeTool();
    const wrapped = wrapTool(tool, sandbox);

    const result = await wrapped.execute(
      { x: 1, code: "1+1" } as any,
      { runId: "r1", workingMemory: {}, signal: new AbortController().signal },
    );

    expect(result).toBe("42");
    expect(sandbox.execute).toHaveBeenCalledWith({
      tool: { name: "test_tool" },
      args: { x: 1, code: "1+1" },
      callId: "r1",
    });
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("throws when the sandbox returns a failure", async () => {
    const sandbox = makeSandbox({
      execute: vi.fn().mockResolvedValue({
        success: false,
        content: "sandbox error: something broke",
        metadata: {},
      }),
    });
    const wrapped = wrapTool(makeTool(), sandbox);

    await expect(
      wrapped.execute(
        { code: "bad" } as any,
        { runId: "r2", workingMemory: {}, signal: new AbortController().signal },
      ),
    ).rejects.toThrow("sandbox error: something broke");
  });

  it("preserves non-execute properties of the original tool", () => {
    const original = makeTool({ name: "my_tool", description: "desc" });
    const wrapped = wrapTool(original, makeSandbox());

    expect(wrapped.name).toBe("my_tool");
    expect(wrapped.description).toBe("desc");
    expect(wrapped.parameters).toBe(original.parameters);
  });
});

describe("withSandbox Plugin", () => {
  it("does nothing when no tools are provided", async () => {
    const sandbox = makeSandbox();
    const plugin = withSandbox({ sandbox });

    // Create a mock inner that records whether it was called
    const inner = vi.fn(async function* () {});

    const wrapped = plugin(inner);
    const gen = wrapped({
      model: "test",
      systemPrompt: "",
      messages: [],
    });

    const events: any[] = [];
    for await (const e of gen) events.push(e);

    expect(inner).toHaveBeenCalled();
  });

  it("wraps all tools when tools is '*' (default)", async () => {
    const sandbox = makeSandbox({
      execute: vi.fn().mockResolvedValue({
        success: true,
        content: "ran-in-sandbox",
        metadata: {},
      }),
    });

    const t1 = makeTool({ name: "tool_a" });
    const t2 = makeTool({ name: "tool_b" });

    // The Plugin wraps tools in input, then delegates to inner.
    // We verify the inner receives wrapped tools whose execute() routes to sandbox.
    let receivedTools: Tool[] = [];
    const inner = vi.fn(async function* () {}) as any;

    const plugin = withSandbox({ sandbox });
    const wrapped = plugin(inner);

    const gen = wrapped({
      model: "test",
      systemPrompt: "",
      messages: [],
      tools: [t1, t2],
    });

    // Capture the tools passed to inner via the function call
    for await (const _ of gen) { /* empty */ }

    const inputArg = inner.mock.calls[0]?.[0];
    receivedTools = inputArg?.tools ?? [];

    expect(receivedTools).toHaveLength(2);

    // Both tools should be wrapped (execute goes to sandbox)
    await receivedTools[0].execute({}, {
      runId: "test",
      workingMemory: {},
      signal: new AbortController().signal,
    });
    await receivedTools[1].execute({}, {
      runId: "test",
      workingMemory: {},
      signal: new AbortController().signal,
    });

    expect(sandbox.execute).toHaveBeenCalledTimes(2);
  });

  it("only wraps tools matching the filter list", async () => {
    const sandbox = makeSandbox({
      execute: vi.fn().mockResolvedValue({
        success: true,
        content: "ok",
        metadata: {},
      }),
    });

    const t1 = makeTool({ name: "code_runner" });
    const t2 = makeTool({ name: "file_reader" });

    const inner = vi.fn(async function* () {}) as any;

    const plugin = withSandbox({ sandbox, tools: ["code_runner"] });
    const wrapped = plugin(inner);

    const gen = wrapped({
      model: "test",
      systemPrompt: "",
      messages: [],
      tools: [t1, t2],
    });

    for await (const _ of gen) { /* empty */ }

    const inputArg = inner.mock.calls[0]?.[0];
    const receivedTools = (inputArg?.tools ?? []) as Tool[];

    // Only code_runner should route to sandbox
    await receivedTools[0].execute({}, {
      runId: "test",
      workingMemory: {},
      signal: new AbortController().signal,
    });
    await receivedTools[1].execute({}, {
      runId: "test",
      workingMemory: {},
      signal: new AbortController().signal,
    });

    expect(sandbox.execute).toHaveBeenCalledTimes(1);
  });
});
