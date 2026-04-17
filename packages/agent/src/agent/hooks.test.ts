import { describe, expect, it, vi } from "vitest";
import {
  createAuditHook,
  createDefaultRunProfile,
  createExperimentHook,
  createLoggingHook,
  createPermissionHook,
  mergeRunProfile,
  type AgentHookEvent,
} from "./hooks";

describe("mergeRunProfile", () => {
  it("merges labels, flags, overrides, and sandbox settings", () => {
    const merged = mergeRunProfile(createDefaultRunProfile(), {
      labels: { env: "prod" },
      featureFlags: { summarize: true },
      model: "openai/gpt-4.1",
      suppressStreaming: true,
      sandboxProfileId: "docker_default",
      sandboxPolicy: { network: false },
    });

    expect(merged.labels.env).toBe("prod");
    expect(merged.featureFlags.summarize).toBe(true);
    expect(merged.overrides.model).toBe("openai/gpt-4.1");
    expect(merged.suppressStreaming).toBe(true);
    expect(merged.sandboxProfileId).toBe("docker_default");
    expect(merged.sandboxPolicy?.network).toBe(false);
  });
});

describe("createPermissionHook", () => {
  it("denies flagged tool calls", async () => {
    const hook = createPermissionHook({
      toolsRequiringConfirmation: ["delete_file"],
      confirm: async () => false,
    });

    const result = await hook.authorizeTools?.({
      runId: "run_1",
      llmRound: 1,
      messages: [],
      invocations: [
        { callId: "c1", name: "delete_file", args: { path: "/tmp/a" } },
        { callId: "c2", name: "read_file", args: { path: "/tmp/a" } },
      ],
      labels: {},
      featureFlags: {},
    });

    expect(result).toEqual({
      action: "deny",
      reason: "User did not approve this tool execution.",
      callIds: ["c1"],
    });
  });

  it("can pause the run instead of denying", async () => {
    const hook = createPermissionHook({
      toolsRequiringConfirmation: ["delete_file"],
      confirm: async () => false,
      onReject: "pause",
      rejectReason: "awaiting approval",
    });

    const result = await hook.authorizeTools?.({
      runId: "run_1",
      llmRound: 1,
      messages: [],
      invocations: [{ callId: "c1", name: "delete_file", args: {} }],
      labels: {},
      featureFlags: {},
    });

    expect(result).toEqual({ action: "pause", reason: "awaiting approval" });
  });
});

describe("hook factories", () => {
  it("forwards audit events", async () => {
    const sink = vi.fn();
    const hook = createAuditHook({ sink });
    const event: AgentHookEvent = {
      type: "run_started",
      runId: "run_1",
      maxSteps: 3,
      model: "openai/gpt-4.1",
      labels: {},
      featureFlags: {},
    };
    await hook.onEvent?.(event);
    expect(sink).toHaveBeenCalledWith(event);
  });

  it("creates experiment assignments", async () => {
    const hook = createExperimentHook({
      assign: async () => ({
        labels: { cohort: "B" },
        temperature: 0.1,
      }),
    });

    const patch = await hook.assignRunProfile?.({
      runId: "run_1",
      maxSteps: 5,
      initial: {
        model: "openai/gpt-4o-mini",
        systemPrompt: "",
        messages: [],
      },
    });

    expect(patch).toEqual({
      labels: { cohort: "B" },
      temperature: 0.1,
    });
  });

  it("logs audit events to the provided logger", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const hook = createLoggingHook({ logger });
    await hook.onEvent?.({
      type: "run_finished",
      runId: "run_1",
      finishReason: "stop",
      llmRounds: 1,
      labels: {},
      featureFlags: {},
    });
    expect(logger.info).toHaveBeenCalled();
  });
});
