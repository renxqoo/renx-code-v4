import { describe, expect, it, vi } from "vitest";
import zod from "zod";
import { DockerSandboxBackend } from "./docker";
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

describe("DockerSandboxBackend", () => {
  it("serializes execution payloads into a docker run contract", async () => {
    const runner = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ success: true, content: "container-ok", metadata: { engine: "docker" } }),
      stderr: "",
      exitCode: 0,
    });
    const backend = new DockerSandboxBackend({
      image: "ghcr.io/acme/agent-sandbox:latest",
      containerCommand: ["node", "/app/runner.js"],
      extraArgs: ["--cpus", "1"],
      runner,
    });
    const tool = makeTool({
      id: "lookup_customer",
      name: "lookup_customer",
      description: "Look up customer data.",
      timeoutMs: 500,
    });

    const result = await backend.execute({
      tool,
      args: { email: "alice@example.com" },
      callId: "call-1",
      context: { profileId: "docker", policy: { network: false } },
    });

    expect(result).toEqual({
      success: true,
      content: "container-ok",
      metadata: { engine: "docker" },
    });
    expect(runner).toHaveBeenCalledOnce();
    const invocation = runner.mock.calls[0][0];
    expect(invocation.command).toBe("docker");
    expect(invocation.args).toEqual([
      "run",
      "--rm",
      "-i",
      "--network",
      "none",
      "--cpus",
      "1",
      "ghcr.io/acme/agent-sandbox:latest",
      "node",
      "/app/runner.js",
    ]);
    expect(JSON.parse(invocation.stdin)).toEqual({
      callId: "call-1",
      args: { email: "alice@example.com" },
      context: { profileId: "docker", policy: { network: false } },
      tool: {
        id: "lookup_customer",
        name: "lookup_customer",
        description: "Look up customer data.",
        type: "read_only",
        timeoutMs: 500,
      },
    });
  });

  it("returns a failure result when docker exits non-zero", async () => {
    const backend = new DockerSandboxBackend({
      image: "ghcr.io/acme/agent-sandbox:latest",
      runner: vi.fn().mockResolvedValue({
        stdout: "",
        stderr: "permission denied",
        exitCode: 125,
      }),
    });
    const tool = makeTool({ id: "write_file", name: "write_file", type: "write_only" });

    const result = await backend.execute({
      tool,
      args: { path: "/tmp/demo" },
      callId: "call-err",
      context: { profileId: "docker" },
    });

    expect(result.success).toBe(false);
    expect(result.content).toMatch(/exited with code 125/);
  });
});
