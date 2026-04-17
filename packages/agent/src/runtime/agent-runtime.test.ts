import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "./agent-runtime";
import * as runtimeModule from "../model/runtime";
import { ToolRegistry } from "../tools/registry";
import { createDefaultSandboxRegistry } from "../sandbox/default-registry";
import type { RuntimeOutcome } from "../model/runtime";

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

describe("AgentRuntime", () => {
  beforeEach(() => {
    runtime.mockReset();
  });

  it("returns a runId and persists checkpoint snapshots", async () => {
    runtime.mockResolvedValue(okOutcome());

    const saveRun = vi.fn();
    const saveStep = vi.fn();
    const agentRuntime = new AgentRuntime({
      maxSteps: 3,
      registry: new ToolRegistry(),
      sandboxRegistry: createDefaultSandboxRegistry(),
      checkpointStore: {
        saveRun,
        saveStep,
      },
    });

    const out = await agentRuntime.run({
      model: "openai/gpt-4o-mini",
      systemPrompt: "Be concise.",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
    });

    expect(out.runId).toBeTruthy();
    expect(saveRun).toHaveBeenCalled();
    expect(saveStep).toHaveBeenCalled();

    const statuses = saveRun.mock.calls.map(([snapshot]) => snapshot.status);
    expect(statuses).toContain("ready");
    expect(statuses).toContain("running");
    expect(statuses).toContain("finished");
  });
});
