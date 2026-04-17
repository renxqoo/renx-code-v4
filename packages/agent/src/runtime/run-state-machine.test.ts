import { describe, expect, it, vi } from "vitest";
import { RunStateMachine } from "./run-state-machine";
import type { AgentCheckpointStore } from "./checkpoint-store";

function createStore(): AgentCheckpointStore {
  return {
    saveRun: vi.fn(),
    saveStep: vi.fn(),
  };
}

const initial = {
  model: "openai/gpt-4o-mini" as const,
  systemPrompt: "You are helpful.",
  messages: [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "hello" }],
    },
  ],
};

describe("RunStateMachine", () => {
  it("persists run and step snapshots across lifecycle transitions", async () => {
    const store = createStore();
    const machine = new RunStateMachine({ initial, maxSteps: 4 }, store);

    await machine.persistRun();
    await machine.start();
    await machine.beginStep(1, 1, initial.messages);
    machine.setMessages([
      ...initial.messages,
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      },
    ]);
    await machine.complete(
      [
        ...initial.messages,
        {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
      ],
      "success",
    );

    expect(store.saveRun).toHaveBeenCalled();
    expect(store.saveStep).toHaveBeenCalled();

    const runSnapshots = vi.mocked(store.saveRun).mock.calls.map(([snapshot]) => snapshot.status);
    expect(runSnapshots).toContain("ready");
    expect(runSnapshots).toContain("running");
    expect(runSnapshots).toContain("finished");

    const stepSnapshots = vi.mocked(store.saveStep).mock.calls.map(([snapshot]) => snapshot.status);
    expect(stepSnapshots).toContain("preparing");
  });

  it("rejects invalid terminal transition", async () => {
    const store = createStore();
    const machine = new RunStateMachine({ initial, maxSteps: 4 }, store);

    await expect(machine.complete(initial.messages, "success")).rejects.toThrow(
      "Invalid run state transition",
    );
  });
});
