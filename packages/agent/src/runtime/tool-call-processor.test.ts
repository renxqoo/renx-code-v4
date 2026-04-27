import { describe, expect, it, vi } from "vitest";
import zod from "zod";
import { createDefaultRunProfile, createPermissionHook } from "../agent/hooks";
import { noopLogger } from "../agent/logger";
import { createDefaultSandboxRegistry } from "../sandbox/default-registry";
import { ToolRegistry } from "../tools/registry";
import { ToolCallProcessor } from "./tool-call-processor";
import { ToolRuntime } from "./tool-runtime";
import type { AgentRunRecord } from "./session-store";

function buildRun(): AgentRunRecord {
  return {
    runId: "run-1",
    status: "running",
    maxSteps: 4,
    llmRounds: 1,
    initial: {
      model: "openai/gpt-4o-mini",
      systemPrompt: "Be concise.",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    },
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("ToolCallProcessor", () => {
  it("pauses with a pending approval payload when a hook requests it", async () => {
    const registry = new ToolRegistry();
    registry.register({
      id: "delete_file",
      name: "delete_file",
      type: "write_only",
      schema: zod.object({ path: zod.string() }),
      execute: vi.fn(),
    });

    const events: string[] = [];
    const processor = new ToolCallProcessor({
      toolRuntime: new ToolRuntime(registry, createDefaultSandboxRegistry(), noopLogger),
      enterpriseHooks: [
        createPermissionHook({
          toolsRequiringConfirmation: ["delete_file"],
          confirm: async () => false,
          onReject: "pause",
          rejectReason: "awaiting approval",
        }),
      ],
      emitEvent: async (event) => {
        events.push(event.type);
      },
    });

    const result = await processor.process({
      run: buildRun(),
      llmRound: 1,
      messages: buildRun().messages,
      profile: createDefaultRunProfile(),
      decision: {
        type: "tool_calls",
        finishReason: "tool_calls",
        assistantText: "Trying a tool.",
        toolCalls: [{ id: "call-1", name: "delete_file", arguments: '{"path":"/tmp/a"}' }],
      },
    });

    expect(result.type).toBe("pause");
    expect(result.pendingApproval.invocations).toEqual([
      { callId: "call-1", name: "delete_file", args: { path: "/tmp/a" } },
    ]);
    expect(events).toEqual(["tool_authorization_requested", "tool_authorization_resolved"]);
  });

  it("returns denied tool results in input order while still executing allowed tools", async () => {
    const registry = new ToolRegistry();
    const readExecute = vi.fn().mockResolvedValue({ success: true, content: "read ok", metadata: {} });
    registry.register({
      id: "delete_file",
      name: "delete_file",
      type: "write_only",
      schema: zod.object({ path: zod.string() }),
      execute: vi.fn().mockResolvedValue({ success: true, content: "deleted", metadata: {} }),
    });
    registry.register({
      id: "read_file",
      name: "read_file",
      type: "read_only",
      schema: zod.object({ path: zod.string() }),
      execute: readExecute,
    });

    const runtimeEvents: string[] = [];
    const processor = new ToolCallProcessor({
      toolRuntime: new ToolRuntime(registry, createDefaultSandboxRegistry(), noopLogger),
      enterpriseHooks: [
        {
          name: "deny-delete",
          authorizeTools: async () => ({
            action: "deny",
            reason: "blocked",
            callIds: ["call-1"],
          }),
        },
      ],
      pushEvents: async (events) => {
        runtimeEvents.push(...events.map((event) => event.type));
      },
    });

    const result = await processor.process({
      run: buildRun(),
      llmRound: 1,
      messages: buildRun().messages,
      profile: createDefaultRunProfile(),
      decision: {
        type: "tool_calls",
        finishReason: "tool_calls",
        assistantText: "",
        toolCalls: [
          { id: "call-1", name: "delete_file", arguments: '{"path":"/tmp/a"}' },
          { id: "call-2", name: "read_file", arguments: '{"path":"/tmp/a"}' },
        ],
      },
    });

    expect(result.type).toBe("continue");
    if (result.type !== "continue") {
      throw new Error("Expected continue result");
    }
    expect(result.results).toEqual([
      {
        success: false,
        content: "Some tool calls were denied.",
        metadata: { denied: true, callId: "call-1", toolName: "delete_file" },
      },
      { success: true, content: "read ok", metadata: {} },
    ]);
    expect(readExecute).toHaveBeenCalledTimes(1);
    expect(runtimeEvents).toEqual(["tool_execution_completed"]);
  });
});
