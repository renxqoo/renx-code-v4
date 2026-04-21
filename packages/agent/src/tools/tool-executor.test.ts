import { describe, expect, it, vi } from "vitest";
import { toolExecutor } from "./tool-executor";
import { createDefaultSandboxRegistry } from "../sandbox/default-registry";
import { HttpSandboxBackend } from "../sandbox/backends/http";
import type { AgentTool } from "./type";
import zod from "zod";

function makeTool(overrides: Partial<AgentTool> & { name: string; id: string }): AgentTool {
  return {
    type: "read_only",
    schema: zod.object({}),
    execute: vi.fn().mockResolvedValue({ success: true, content: "ok", metadata: {} }),
    ...overrides,
  };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("toolExecutor", () => {
  it("executes read-only tools concurrently", async () => {
    const order: string[] = [];
    const t1 = makeTool({
      id: "r1",
      name: "read1",
      type: "read_only",
      execute: async () => {
        await delay(10);
        order.push("r1");
        return { success: true, content: "r1", metadata: {} };
      },
    });
    const t2 = makeTool({
      id: "r2",
      name: "read2",
      type: "read_only",
      execute: async () => {
        order.push("r2");
        return { success: true, content: "r2", metadata: {} };
      },
    });

    const results = await toolExecutor([
      { tool: t1, args: {}, callId: "c1" },
      { tool: t2, args: {}, callId: "c2" },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(true);
  });

  it("executes write tools sequentially and stops on failure", async () => {
    const order: string[] = [];
    const t1 = makeTool({
      id: "w1",
      name: "write1",
      type: "write_only",
      execute: async () => {
        order.push("w1");
        return { success: false, content: "fail", metadata: {} };
      },
    });
    const t2 = makeTool({
      id: "w2",
      name: "write2",
      type: "write_only",
      execute: async () => {
        order.push("w2");
        return { success: true, content: "ok", metadata: {} };
      },
    });

    const results = await toolExecutor([
      { tool: t1, args: {}, callId: "c1" },
      { tool: t2, args: {}, callId: "c2" },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(false);
    // w2 should be skipped
    expect(results[1].success).toBe(false);
    expect(results[1].metadata.skipped).toBe(true);
    expect(order).toEqual(["w1"]);
  });

  it("skips read phase after write failure", async () => {
    const w = makeTool({
      id: "w1",
      name: "write1",
      type: "write_only",
      execute: async () => ({ success: false, content: "fail", metadata: {} }),
    });
    const r = makeTool({
      id: "r1",
      name: "read1",
      type: "read_only",
      execute: async () => ({ success: true, content: "ok", metadata: {} }),
    });

    const results = await toolExecutor([
      { tool: w, args: {}, callId: "c1" },
      { tool: r, args: {}, callId: "c2" },
    ]);

    expect(results[1].success).toBe(false);
    expect(results[1].metadata.skipped).toBe(true);
    expect(results[1].metadata.kind).toBe("read");
  });

  it("returns empty for zero invocations", async () => {
    const results = await toolExecutor([]);
    expect(results).toEqual([]);
  });

  it("times out a slow tool when timeoutMs is set", async () => {
    const slow: AgentTool = {
      id: "slow",
      name: "slow_tool",
      type: "read_only",
      schema: zod.object({}),
      timeoutMs: 10,
      execute: async () => {
        await delay(500);
        return { success: true, content: "late", metadata: {} };
      },
    };

    const results = await toolExecutor([{ tool: slow, args: {}, callId: "c1" }]);
    expect(results[0].success).toBe(false);
    expect(results[0].content).toMatch(/timed out/);
  });

  it("passes tool execution through sandbox backend", async () => {
    const sandbox = createDefaultSandboxRegistry();
    const tool = makeTool({ id: "t1", name: "echo", type: "read_only" });

    const results = await toolExecutor(
      [{ tool, args: {}, callId: "c1" }],
      {
        sandboxRegistry: sandbox,
        getSandboxContext: () => ({ profileId: "in_process" }),
      },
    );

    expect(results[0].success).toBe(true);
  });

  it("routes execution to a registered remote sandbox backend", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, content: "remote", metadata: { profile: "remote" } }), {
        status: 200,
      }),
    );
    const sandbox = createDefaultSandboxRegistry().register(
      "remote",
      new HttpSandboxBackend({
        endpoint: "https://sandbox.example/execute",
        fetch: fetchMock as typeof fetch,
      }),
    );
    const tool = makeTool({ id: "t1", name: "echo", type: "read_only", sandboxProfileId: "remote" });

    const results = await toolExecutor(
      [{ tool, args: { value: "hello" }, callId: "c1" }],
      {
        sandboxRegistry: sandbox,
        getSandboxContext: () => ({ profileId: "remote", traceId: "trace-1" }),
      },
    );

    expect(results[0]).toEqual({
      success: true,
      content: "remote",
      metadata: { profile: "remote" },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
