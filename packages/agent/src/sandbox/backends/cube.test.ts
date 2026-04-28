import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { AgentTool } from "../../tools/type";
import { CubeSandboxBackend } from "./cube";

const mockKill = vi.fn().mockResolvedValue(undefined);
const mockRunCode = vi.fn();
const mockCreate = vi.fn();

vi.mock("@e2b/code-interpreter", () => ({
  Sandbox: {
    create: (...args: unknown[]) => mockCreate(...args),
  },
}));

function makeTool(overrides: Partial<AgentTool> = {}): AgentTool {
  return {
    id: "test_tool",
    name: "Test Tool",
    type: "read_only",
    schema: z.object({
      code: z.string().optional(),
    }),
    execute: vi.fn(),
    ...overrides,
  };
}

function makeSandboxStub(overrides: { runCode?: typeof mockRunCode } = {}) {
  const runCode = overrides.runCode ?? mockRunCode;
  return {
    runCode,
    kill: mockKill,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CubeSandboxBackend", () => {
  it("creates a sandbox, runs code and returns a structured result", async () => {
    const backend = new CubeSandboxBackend({
      templateId: "tmpl-test",
      apiUrl: "http://localhost:3000",
      apiKey: "key-123",
    });

    const sandboxStub = makeSandboxStub({
      runCode: vi.fn().mockResolvedValue({
        results: [{ text: "42" }],
        logs: { stdout: ["hello"], stderr: [] },
        error: null,
        text: "42",
      }),
    });
    mockCreate.mockResolvedValue(sandboxStub);

    const result = await backend.execute({
      tool: makeTool(),
      args: { code: "1 + 1" },
      callId: "call-1",
      context: {
        profileId: "cube_sandbox",
        tenantId: "t-1",
        traceId: "trace-1",
      },
    });

    expect(result.success).toBe(true);
    expect(result.content).toContain("hello");
    expect(result.content).toContain("42");
    expect(result.metadata.name).toBe("Test Tool");
    expect(result.metadata.id).toBe("call-1");
    expect(result.metadata.results).toEqual([{ text: "42" }]);

    expect(mockCreate).toHaveBeenCalledWith({
      apiKey: "key-123",
      apiUrl: "http://localhost:3000",
      template: "tmpl-test",
    });
    expect(sandboxStub.runCode).toHaveBeenCalledWith("1 + 1");
    // Sandbox is session-scoped — kill only on dispose(), not after each execute()
    expect(mockKill).not.toHaveBeenCalled();
  });

  it("reuses the same sandbox across multiple execute() calls", async () => {
    const backend = new CubeSandboxBackend({
      templateId: "tmpl-test",
    });

    const sandboxStub = makeSandboxStub({
      runCode: vi.fn().mockResolvedValue({
        results: [],
        logs: { stdout: [], stderr: [] },
        error: null,
      }),
    });
    mockCreate.mockResolvedValue(sandboxStub);

    // First call creates the sandbox
    await backend.execute({
      tool: makeTool(),
      args: { code: "a = 1" },
      callId: "call-1",
      context: { profileId: "cube_sandbox" },
    });

    // Second call reuses it
    await backend.execute({
      tool: makeTool(),
      args: { code: "print(a)" },
      callId: "call-2",
      context: { profileId: "cube_sandbox" },
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(sandboxStub.runCode).toHaveBeenCalledTimes(2);
    expect(mockKill).not.toHaveBeenCalled();
  });

  it("returns a failure result when sandbox creation fails", async () => {
    const backend = new CubeSandboxBackend({
      templateId: "tmpl-test",
    });

    mockCreate.mockRejectedValue(new Error("connection refused"));

    const result = await backend.execute({
      tool: makeTool({ name: "Code Runner" }),
      args: { code: "1 + 1" },
      callId: "call-2",
      context: { profileId: "cube_sandbox" },
    });

    expect(result.success).toBe(false);
    expect(result.content).toContain("connection refused");
    expect(result.metadata.name).toBe("Code Runner");
    expect(mockKill).not.toHaveBeenCalled();
  });

  it("clears the sandbox state on runCode failure and recreates on next call", async () => {
    const backend = new CubeSandboxBackend({
      templateId: "tmpl-test",
    });

    const sandboxStub1 = makeSandboxStub({
      runCode: vi.fn().mockRejectedValue(new Error("runtime crash")),
    });
    const sandboxStub2 = makeSandboxStub({
      runCode: vi.fn().mockResolvedValue({
        results: [],
        logs: { stdout: ["recovered"], stderr: [] },
        error: null,
      }),
    });
    mockCreate
      .mockResolvedValueOnce(sandboxStub1)
      .mockResolvedValueOnce(sandboxStub2);

    // First call: runCode throws, sandbox cleared
    const result1 = await backend.execute({
      tool: makeTool(),
      args: { code: "throw new Error()" },
      callId: "call-3",
      context: { profileId: "cube_sandbox" },
    });

    expect(result1.success).toBe(false);
    expect(result1.content).toContain("runtime crash");

    // Second call: creates a fresh sandbox
    const result2 = await backend.execute({
      tool: makeTool(),
      args: { code: "print('ok')" },
      callId: "call-4",
      context: { profileId: "cube_sandbox" },
    });

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result2.success).toBe(true);
    expect(result2.content).toContain("recovered");
    expect(mockKill).not.toHaveBeenCalled();
  });

  it("returns a failure result when the sandbox reports a code execution error", async () => {
    const backend = new CubeSandboxBackend({
      templateId: "tmpl-test",
    });

    const sandboxStub = makeSandboxStub({
      runCode: vi.fn().mockResolvedValue({
        results: [],
        logs: { stdout: [], stderr: ["SyntaxError: unexpected token"] },
        error: { name: "SyntaxError", value: "unexpected token", traceback: "" },
      }),
    });
    mockCreate.mockResolvedValue(sandboxStub);

    const result = await backend.execute({
      tool: makeTool({ name: "Code Runner" }),
      args: { code: "!!!" },
      callId: "call-4",
      context: { profileId: "cube_sandbox" },
    });

    expect(result.success).toBe(false);
    expect(result.content).toContain("SyntaxError");
    expect(result.content).toContain("unexpected token");
    expect(result.metadata.error).toBeDefined();
    expect(result.metadata.logs).toBeDefined();
    // Non-exception error — sandbox stays alive for reuse
    expect(mockKill).not.toHaveBeenCalled();
  });

  it("falls back to JSON.stringify(args) when no code field is present", async () => {
    const backend = new CubeSandboxBackend({
      templateId: "tmpl-test",
    });

    const sandboxStub = makeSandboxStub({
      runCode: vi.fn().mockResolvedValue({
        results: [],
        logs: { stdout: ["ok"], stderr: [] },
        error: null,
        text: "ok",
      }),
    });
    mockCreate.mockResolvedValue(sandboxStub);

    const result = await backend.execute({
      tool: makeTool(),
      args: { x: 1, y: 2 },
      callId: "call-5",
      context: { profileId: "cube_sandbox" },
    });

    expect(result.success).toBe(true);
    expect(sandboxStub.runCode).toHaveBeenCalledWith(JSON.stringify({ x: 1, y: 2 }));
  });

  it("uses the configured id (default cube_sandbox)", () => {
    const a = new CubeSandboxBackend({ templateId: "t1" });
    expect(a.id).toBe("cube_sandbox");

    const b = new CubeSandboxBackend({ templateId: "t2", id: "my_cube" });
    expect(b.id).toBe("my_cube");
  });

  it("dispose is a no-op when no sandbox was created", async () => {
    const backend = new CubeSandboxBackend({ templateId: "t1" });
    await expect(backend.dispose()).resolves.toBeUndefined();
    expect(mockKill).not.toHaveBeenCalled();
  });

  it("dispose kills the sandbox if one was created", async () => {
    const backend = new CubeSandboxBackend({
      templateId: "tmpl-test",
    });

    const sandboxStub = makeSandboxStub({
      runCode: vi.fn().mockResolvedValue({
        results: [],
        logs: { stdout: [], stderr: [] },
        error: null,
      }),
    });
    mockCreate.mockResolvedValue(sandboxStub);

    // Execute to create a sandbox
    await backend.execute({
      tool: makeTool(),
      args: { code: "1 + 1" },
      callId: "call-dispose",
      context: { profileId: "cube_sandbox" },
    });

    // Dispose should kill it
    await backend.dispose();

    expect(mockKill).toHaveBeenCalledOnce();
  });
});
