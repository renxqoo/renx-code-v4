import { describe, it, expect } from "vitest";
import { handoff } from "../../src/multi-agent/handoff.js";
import { agent } from "../../src/agent.js";
import { userMessage } from "../../src/message.js";
import { HandoffSignal } from "../../src/handoff-signal.js";
import {
  createSingleResponseClient,
  createToolCallDeltaChunk,
  createFinishChunk,
} from "../fixtures/mock-llm-client.js";
import type { AgentEvent } from "../../src/events.js";

describe("handoff", () => {
  it("handoff tool throws HandoffSignal when executed", async () => {
    const handoffTool = handoff({
      to: "target-agent",
    });

    try {
      await handoffTool.execute({ reason: "Need help" }, {} as any);
      expect.unreachable("Should have thrown HandoffSignal");
    } catch (err) {
      expect(err).toBeInstanceOf(HandoffSignal);
      expect((err as HandoffSignal).targetAgent).toBe("target-agent");
      expect((err as HandoffSignal).reason).toBe("Need help");
    }
  });

  it("handoff tool uses custom name and description", () => {
    const handoffTool = handoff({
      to: "analyst",
      name: "transfer_to_analyst",
      description: "Transfer to the analyst team",
    });

    expect(handoffTool.name).toBe("transfer_to_analyst");
    expect(handoffTool.description).toBe("Transfer to the analyst team");
  });

  it("handoff tool uses default name when not specified", () => {
    const handoffTool = handoff({
      to: "researcher",
    });

    expect(handoffTool.name).toBe("handoff_to_researcher");
    expect(handoffTool.description).toContain("researcher");
  });

  it("agent catches HandoffSignal and yields handoff and run:finished events", async () => {
    const handoffTool = handoff({ to: "analyst" });

    const events: AgentEvent[] = [];
    for await (const event of agent({
      model: "test",
      systemPrompt: "Use handoff tool when needed",
      messages: [userMessage("Transfer to analyst")],
      tools: [handoffTool],
      llmClient: createSingleResponseClient([
        createToolCallDeltaChunk("c1", "handoff_to_analyst", '{"reason":"Need analysis"}'),
        createFinishChunk("tool_calls", { input: 8, output: 4 }),
      ]),
    })) {
      events.push(event);
    }

    // Should yield handoff event
    const handoffEvents = events.filter(e => e.type === "handoff");
    expect(handoffEvents.length).toBeGreaterThan(0);
    expect((handoffEvents[0] as any).to).toBe("analyst");
    expect((handoffEvents[0] as any).reason).toContain("Need analysis");

    // Should yield run:finished with handoff reason
    const finishedEvents = events.filter(
      (e): e is AgentEvent & { type: "run:finished"; outcome: any } => e.type === "run:finished"
    );
    expect(finishedEvents.length).toBeGreaterThan(0);
    expect(finishedEvents[0]!.outcome.finishReason).toBe("handoff");
    expect(finishedEvents[0]!.outcome.handoff?.targetAgent).toBe("analyst");
  });

  it("handoff tool with reason parameter uses it in HandoffSignal", async () => {
    const handoffTool = handoff({ to: "reviewer" });

    try {
      await handoffTool.execute({ reason: "Code review needed" }, {} as any);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as HandoffSignal).reason).toBe("Code review needed");
    }
  });

  it("agent run:finished outcome includes handoff info", async () => {
    const handoffTool = handoff({ to: "target", name: "switch_agent" });

    const events: AgentEvent[] = [];
    for await (const event of agent({
      model: "test",
      systemPrompt: "Transfer when asked",
      messages: [userMessage("Transfer")],
      tools: [handoffTool],
      llmClient: createSingleResponseClient([
        createToolCallDeltaChunk("c1", "switch_agent", '{"reason":"Routing"}'),
        createFinishChunk("tool_calls", { input: 5, output: 2 }),
      ]),
    })) {
      events.push(event);
    }

    const finished = events.find(
      (e): e is AgentEvent & { type: "run:finished"; outcome: any } => e.type === "run:finished"
    );
    expect(finished).toBeDefined();
    expect(finished!.outcome.handoff).toBeDefined();
    expect(finished!.outcome.handoff!.targetAgent).toBe("target");
  });
});
