import { describe, it, expect } from "vitest";
import { pipe } from "../../src/plugin.js";
import { withApproval } from "../../src/plugins/approval.js";
import { agent } from "../../src/agent.js";
import { userMessage } from "../../src/message.js";
import { echoTool, greetTool } from "../fixtures/mock-tools.js";
import {
  createSingleResponseClient,
  createMultiStepClient,
  createToolCallDeltaChunk,
  createTextDeltaChunk,
  createFinishChunk,
} from "../fixtures/mock-llm-client.js";
import type { AgentEvent } from "../../src/events.js";

function lastEvent<T extends AgentEvent>(events: AgentEvent[], type: string): T | undefined {
  return events.filter((e) => e.type === type).pop() as T | undefined;
}

describe("withApproval", () => {
  // 1. allow → tools execute
  it("allows tools to execute when approve() returns allow", async () => {
    const client = createMultiStepClient(
      [
        createToolCallDeltaChunk("c1", "echo", '{"message":"hello"}'),
        createFinishChunk("tool_calls", { input: 8, output: 4 }),
      ],
      [
        createTextDeltaChunk("Done."),
        createFinishChunk("stop", { input: 2, output: 1 }),
      ],
    );

    const fn = pipe(
      withApproval({
        approve: async () => ({ action: "allow" }),
      }),
      agent,
    );

    const events: AgentEvent[] = [];
    for await (const event of fn({
      model: "test",
      systemPrompt: "Use tools",
      messages: [userMessage("echo hello")],
      tools: [echoTool],
      llmClient: client,
    })) {
      events.push(event);
    }

    expect(events.some(e => e.type === "tool:result")).toBe(true);
    const result = lastEvent<any>(events, "run:finished");
    expect(result.outcome.finishReason).toBe("stop");
  });

  // 2. deny → specific tools denied, others execute
  it("denies specified tools and allows others when approve() returns deny", async () => {
    const client = createMultiStepClient(
      [
        createToolCallDeltaChunk("c1", "echo", '{"message":"hello"}'),
        createToolCallDeltaChunk("c2", "greet", '{"name":"World"}'),
        createFinishChunk("tool_calls", { input: 8, output: 4 }),
      ],
      [
        createTextDeltaChunk("Done."),
        createFinishChunk("stop", { input: 2, output: 1 }),
      ],
    );

    const fn = pipe(
      withApproval({
        approve: async () => ({ action: "deny", callIds: ["c1"] }),
      }),
      agent,
    );

    const events: AgentEvent[] = [];
    for await (const event of fn({
      model: "test",
      systemPrompt: "Use tools",
      messages: [userMessage("test")],
      tools: [echoTool, greetTool],
      llmClient: client,
    })) {
      events.push(event);
    }

    const toolErrors = events.filter(
      (e: any) => e.type === "tool:error" && e.callId === "c1"
    );
    expect(toolErrors.length).toBeGreaterThan(0);

    const toolResults = events.filter(
      (e: any) => e.type === "tool:result" && e.callId === "c2"
    );
    expect(toolResults.length).toBeGreaterThan(0);
  });

  // 3. abort → run terminates
  it("aborts the run when approve() returns abort", async () => {
    const client = createSingleResponseClient([
      createToolCallDeltaChunk("c1", "echo", '{"message":"hello"}'),
      createFinishChunk("tool_calls", { input: 5, output: 2 }),
    ]);

    const fn = pipe(
      withApproval({
        approve: async () => ({ action: "abort", reason: "Not allowed" }),
      }),
      agent,
    );

    const events: AgentEvent[] = [];
    for await (const event of fn({
      model: "test",
      systemPrompt: "Use tools",
      messages: [userMessage("test")],
      tools: [echoTool],
      llmClient: client,
    })) {
      events.push(event);
    }

    const result = lastEvent<any>(events, "run:finished");
    expect(result).toBeDefined();
    expect(result.outcome.finishReason).toBe("error");
    expect(result.outcome.error.message).toBe("Not allowed");
  });

  // 4. pause → yields pause:approval, generator stops
  it("yields pause:approval and stops when approve() returns pause", async () => {
    const client = createSingleResponseClient([
      createToolCallDeltaChunk("c1", "echo", '{"message":"hello"}'),
      createToolCallDeltaChunk("c2", "greet", '{"name":"World"}'),
      createFinishChunk("tool_calls", { input: 5, output: 2 }),
    ]);

    const fn = pipe(
      withApproval({
        approve: async () => ({ action: "pause", callIds: ["c1"] }),
      }),
      agent,
    );

    const events: AgentEvent[] = [];
    for await (const event of fn({
      model: "test",
      systemPrompt: "Use tools",
      messages: [userMessage("test")],
      tools: [echoTool, greetTool],
      llmClient: client,
    })) {
      events.push(event);
    }

    const pauseEvent = lastEvent<any>(events, "pause:approval");
    expect(pauseEvent).toBeDefined();
    expect(pauseEvent.callIds).toContain("c1");
    expect(events.filter(e => e.type === "run:finished").length).toBe(0);
  });

  // 5. resume with priorApprovals (allow)
  it("resumes with priorApprovals as allow", async () => {
    const client = createMultiStepClient(
      [
        createToolCallDeltaChunk("c1", "echo", '{"message":"hello"}'),
        createFinishChunk("tool_calls", { input: 8, output: 4 }),
      ],
      [
        createTextDeltaChunk("Done."),
        createFinishChunk("stop", { input: 2, output: 1 }),
      ],
    );

    const fn = pipe(
      withApproval({
        approve: async () => ({ action: "allow" }),
      }),
      agent,
    );

    const events: AgentEvent[] = [];
    for await (const event of fn({
      model: "test",
      systemPrompt: "Use tools",
      messages: [userMessage("echo hello")],
      tools: [echoTool],
      llmClient: client,
      _internal: {
        resumeApprovals: [{ callId: "c1", action: "allow" }],
      },
    })) {
      events.push(event);
    }

    expect(events.some(e => e.type === "tool:result")).toBe(true);
  });

  // 6. resume with priorApprovals (deny)
  it("resumes with priorApprovals as deny", async () => {
    const client = createMultiStepClient(
      [
        createToolCallDeltaChunk("c1", "echo", '{"message":"hello"}'),
        createFinishChunk("tool_calls", { input: 8, output: 4 }),
      ],
      [
        createTextDeltaChunk("Done."),
        createFinishChunk("stop", { input: 2, output: 1 }),
      ],
    );

    const fn = pipe(
      withApproval({
        approve: async () => ({ action: "allow" }),
      }),
      agent,
    );

    const events: AgentEvent[] = [];
    for await (const event of fn({
      model: "test",
      systemPrompt: "Use tools",
      messages: [userMessage("echo hello")],
      tools: [echoTool],
      llmClient: client,
      _internal: {
        resumeApprovals: [{ callId: "c1", action: "deny" }],
      },
    })) {
      events.push(event);
    }

    const toolErrors = events.filter(
      (e: any) => e.type === "tool:error" && e.callId === "c1"
    );
    expect(toolErrors.length).toBeGreaterThan(0);
  });

  // 7. compose with existing onTools
  it("composes with existing onTools callback", async () => {
    const client = createMultiStepClient(
      [
        createToolCallDeltaChunk("c1", "echo", '{"message":"hello"}'),
        createFinishChunk("tool_calls", { input: 8, output: 4 }),
      ],
      [
        createTextDeltaChunk("Done."),
        createFinishChunk("stop", { input: 2, output: 1 }),
      ],
    );

    let existingOnToolsCalled = false;
    let approvalCalled = false;

    const fn = pipe(
      withApproval({
        approve: async () => {
          approvalCalled = true;
          return { action: "allow" };
        },
      }),
      agent,
    );

    const events: AgentEvent[] = [];
    for await (const event of fn({
      model: "test",
      systemPrompt: "Use tools",
      messages: [userMessage("echo hello")],
      tools: [echoTool],
      llmClient: client,
      onTools: async () => {
        existingOnToolsCalled = true;
        return { action: "execute" };
      },
    })) {
      events.push(event);
    }

    expect(existingOnToolsCalled).toBe(true);
    expect(approvalCalled).toBe(true);
    expect(events.some(e => e.type === "tool:result")).toBe(true);
  });
});
