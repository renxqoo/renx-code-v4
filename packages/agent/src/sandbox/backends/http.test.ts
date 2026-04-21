import { describe, expect, it, vi } from "vitest";
import zod from "zod";
import { HttpSandboxBackend } from "./http";
import type { AgentTool } from "../../tools/type";

function makeTool(overrides: Partial<AgentTool> & { id: string; name: string }): AgentTool {
  return {
    id: overrides.id,
    name: overrides.name,
    type: "read_only",
    schema: zod.object({}),
    execute: vi.fn(),
    ...overrides,
  };
}

describe("HttpSandboxBackend", () => {
  it("posts serialized execution requests to the remote sandbox", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, content: "remote-ok", metadata: { backend: "http" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const backend = new HttpSandboxBackend({
      endpoint: "https://sandbox.example/execute",
      fetch: fetchMock as typeof fetch,
      headers: async () => ({ authorization: "Bearer token" }),
    });

    const tool = makeTool({
      id: "lookup_customer",
      name: "lookup_customer",
      description: "Look up CRM data.",
      timeoutMs: 500,
    });

    const result = await backend.execute({
      tool,
      args: { email: "alice@example.com" },
      callId: "call-1",
      context: { profileId: "remote", tenantId: "tenant-a", traceId: "trace-1", policy: { network: false } },
    });

    expect(result).toEqual({
      success: true,
      content: "remote-ok",
      metadata: { backend: "http" },
    });
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://sandbox.example/execute");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer token",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      callId: "call-1",
      args: { email: "alice@example.com" },
      context: {
        profileId: "remote",
        tenantId: "tenant-a",
        traceId: "trace-1",
        policy: { network: false },
      },
      tool: {
        id: "lookup_customer",
        name: "lookup_customer",
        description: "Look up CRM data.",
        type: "read_only",
        timeoutMs: 500,
      },
    });
  });

  it("returns a tool failure when the remote sandbox rejects the request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    const backend = new HttpSandboxBackend({
      endpoint: "https://sandbox.example/execute",
      fetch: fetchMock as typeof fetch,
    });
    const tool = makeTool({ id: "write_file", name: "write_file", type: "write_only" });

    const result = await backend.execute({
      tool,
      args: { path: "/tmp/demo" },
      callId: "call-err",
      context: { profileId: "remote" },
    });

    expect(result.success).toBe(false);
    expect(result.content).toMatch(/HTTP 500/);
    expect(result.metadata.name).toBe("write_file");
  });
});
