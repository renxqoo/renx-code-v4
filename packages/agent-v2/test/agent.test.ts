import { describe, it, expect, beforeAll } from "vitest";
import { agent } from "../src/agent.js";
import { setDefaultLLMClient } from "../src/llm-client.js";
import { userMessage } from "../src/message.js";
import type { AgentEvent, AgentResult } from "../src/index.js";
import {
  createMockLLMClient,
  createSingleResponseClient,
  createMultiStepClient,
  createTextDeltaChunk,
  createToolCallDeltaChunk,
  createFinishChunk,
  createErrorChunk,
} from "./fixtures/mock-llm-client.js";
import {
  echoTool,
  greetTool,
  calculatorTool,
  failingTool,
} from "./fixtures/mock-tools.js";

async function collectEvents(
  gen: AsyncGenerator<AgentEvent, void, void>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function lastEvent<T extends AgentEvent>(
  events: AgentEvent[],
  type: string,
): T | undefined {
  return events.filter((e) => e.type === type).pop() as T | undefined;
}

function findEvents<T extends AgentEvent>(
  events: AgentEvent[],
  type: string,
): T[] {
  return events.filter((e) => e.type === type) as T[];
}

function getResult(events: AgentEvent[]): AgentResult | undefined {
  const finished = lastEvent<AgentEvent & { outcome: AgentResult }>(
    events,
    "run:finished",
  );
  return finished?.outcome;
}

describe("agent()", () => {
  beforeAll(() => {
    setDefaultLLMClient(
      createSingleResponseClient([
        createTextDeltaChunk("Hello"),
        createTextDeltaChunk(" world!"),
        createFinishChunk("stop"),
      ]),
    );
  });

  // 1. Simple text response
  it("yields correct event sequence for a simple text response", async () => {
    const client = createSingleResponseClient([
      createTextDeltaChunk("Hey"),
      createTextDeltaChunk(" there!"),
      createFinishChunk("stop", { input: 5, output: 3 }),
    ]);

    const events = await collectEvents(
      agent({
        model: "test",
        systemPrompt: "Be helpful",
        messages: [userMessage("Hi")],
        llmClient: client,
      }),
    );

    const types = events.map((e) => e.type);
    expect(types).toContain("run:started");
    expect(types).toContain("step:started");
    expect(types).toContain("llm:delta");
    expect(types).not.toContain("llm:tool-call");
    expect(types).toContain("llm:done");
    expect(types).toContain("step:completed");
    expect(types).toContain("run:finished");

    const result = getResult(events);
    expect(result).toBeDefined();
    expect(result!.finishReason).toBe("stop");
    expect(result!.text).toContain("Hey there!");

    // Verify event order
    const startedIdx = types.indexOf("run:started");
    const stepIdx = types.indexOf("step:started");
    const deltaIdx = types.indexOf("llm:delta");
    const doneIdx = types.indexOf("llm:done");
    const completedIdx = types.indexOf("step:completed");
    const finishedIdx = types.indexOf("run:finished");
    expect(startedIdx).toBeLessThan(stepIdx);
    expect(stepIdx).toBeLessThan(deltaIdx);
    expect(deltaIdx).toBeLessThan(doneIdx);
    expect(doneIdx).toBeLessThan(completedIdx);
    expect(completedIdx).toBeLessThan(finishedIdx);
  });

  // 2. Tool-calling flow (with follow-up stop response)
  it("yields llm:tool-call, tool:start, tool:result, run:finished", async () => {
    const client = createMultiStepClient(
      // Step 1: tool call
      [
        createToolCallDeltaChunk("c1", "echo", '{"mess'),
        createToolCallDeltaChunk("c1", "", 'age": "hello"}'),
        createFinishChunk("tool_calls", { input: 8, output: 4 }),
      ],
      // Step 2: final text response
      [
        createTextDeltaChunk("Echoed!"),
        createFinishChunk("stop", { input: 5, output: 3 }),
      ],
    );

    const events = await collectEvents(
      agent({
        model: "test",
        systemPrompt: "Use tools",
        messages: [userMessage("echo hello")],
        tools: [echoTool],
        llmClient: client,
      }),
    );

    const types = events.map((e) => e.type);
    expect(types).toContain("llm:tool-call");
    expect(types).toContain("tool:start");
    expect(types).toContain("tool:result");
    expect(types).toContain("step:completed");
    expect(types).toContain("run:finished");

    const toolCallEvent = lastEvent<any>(events, "llm:tool-call");
    expect(toolCallEvent).toBeDefined();
    expect(toolCallEvent.name).toBe("echo");
    expect(toolCallEvent.arguments).toEqual({ message: "hello" });

    const toolStart = lastEvent<any>(events, "tool:start");
    expect(toolStart).toBeDefined();
    expect(toolStart.callId).toBe("c1");

    const toolResult = lastEvent<any>(events, "tool:result");
    expect(toolResult).toBeDefined();
    expect(toolResult.ok).toBe(true);
    expect(toolResult.output).toEqual({ echoed: "hello" });

    const result = getResult(events);
    expect(result).toBeDefined();
    expect(result!.finishReason).toBe("stop");
  });

  // 3. Multiple steps
  it("goes through multiple ReAct cycles", async () => {
    const client = createMultiStepClient(
      // Step 1: tool call → calculator
      [
        createTextDeltaChunk("Let me calculate."),
        createToolCallDeltaChunk(
          "c1",
          "calculator",
          '{"operation":"add","a":1,"b":2}',
        ),
        createFinishChunk("tool_calls", { input: 10, output: 5 }),
      ],
      // Step 2: final response
      [
        createTextDeltaChunk("The result is 3."),
        createFinishChunk("stop", { input: 10, output: 5 }),
      ],
    );

    const events = await collectEvents(
      agent({
        model: "test",
        systemPrompt: "Calculate",
        messages: [userMessage("1+2")],
        tools: [calculatorTool],
        llmClient: client,
      }),
    );

    const stepStarted = findEvents<any>(events, "step:started");
    expect(stepStarted.length).toBe(2);
    expect(stepStarted[0].step).toBe(1);
    expect(stepStarted[1].step).toBe(2);

    const stepCompleted = findEvents<any>(events, "step:completed");
    expect(stepCompleted.length).toBe(2);
    expect(stepCompleted[0].step).toBe(1);
    expect(stepCompleted[0].finishReason).toBe("tool_calls");
    expect(stepCompleted[1].step).toBe(2);
    expect(stepCompleted[1].finishReason).toBe("stop");

    const result = getResult(events);
    expect(result!.totalSteps).toBe(2);
    expect(result!.finishReason).toBe("stop");
  });

  // 4. maxSteps exceeded
  it("stops with finishReason max_steps when limit exceeded", async () => {
    const client = createMockLLMClient(
      [
        createToolCallDeltaChunk("c1", "echo", '{"message":"test"}'),
        createFinishChunk("tool_calls", { input: 5, output: 2 }),
      ],
      [
        createToolCallDeltaChunk("c2", "echo", '{"message":"test2"}'),
        createFinishChunk("tool_calls", { input: 5, output: 2 }),
      ],
      [
        createToolCallDeltaChunk("c3", "echo", '{"message":"test3"}'),
        createFinishChunk("tool_calls", { input: 5, output: 2 }),
      ],
    );

    const events = await collectEvents(
      agent({
        model: "test",
        systemPrompt: "Echo",
        messages: [userMessage("test")],
        tools: [echoTool],
        llmClient: client,
        maxSteps: 2,
      }),
    );

    const result = getResult(events);
    expect(result).toBeDefined();
    expect(result!.finishReason).toBe("max_steps");
    expect(result!.totalSteps).toBe(2);
  });

  // 5. Cancellation via AbortSignal
  it("yields run:cancelled when AbortSignal fires mid-stream", async () => {
    const controller = new AbortController();
    let yieldedDelta = false;

    const client: import("../src/llm-client.js").LLMClient = {
      stream: async function* () {
        yield { type: "text-delta" as const, delta: "Hello" };
        controller.abort();
        yield { type: "text-delta" as const, delta: " after abort?" };
      },
    };

    const events: AgentEvent[] = [];
    for await (const event of agent({
      model: "test",
      systemPrompt: "Be helpful",
      messages: [userMessage("Hi")],
      llmClient: client,
      signal: controller.signal,
    })) {
      events.push(event);
      if (event.type === "llm:delta") yieldedDelta = true;
    }

    expect(yieldedDelta).toBe(true);
    expect(events.some((e) => e.type === "run:cancelled")).toBe(true);

    const result = getResult(events);
    expect(result).toBeDefined();
    expect(result!.finishReason).toBe("cancelled");
  });

  // 6. onTools: execute
  it("onTools: execute — tools execute normally", async () => {
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

    let calledOnTools = false;
    const events = await collectEvents(
      agent({
        model: "test",
        systemPrompt: "Use tools",
        messages: [userMessage("echo hello")],
        tools: [echoTool],
        llmClient: client,
        onTools(ctx) {
          calledOnTools = true;
          expect(ctx.toolCalls.length).toBe(1);
          expect(ctx.toolCalls[0]!.name).toBe("echo");
          return { action: "execute" };
        },
      }),
    );

    expect(calledOnTools).toBe(true);
    expect(events.some((e) => e.type === "tool:result")).toBe(true);
    const result = getResult(events);
    expect(result!.finishReason).toBe("stop");
  });

  // 7. onTools: deny
  it("onTools: deny — specified tool skipped, error events emitted", async () => {
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

    const events = await collectEvents(
      agent({
        model: "test",
        systemPrompt: "Use tools",
        messages: [userMessage("test")],
        tools: [echoTool, greetTool],
        llmClient: client,
        onTools(ctx) {
          return { action: "deny", callIds: ["c1"], reason: "Denied" };
        },
      }),
    );

    const toolErrors = findEvents<any>(events, "tool:error");
    expect(toolErrors.some((e) => e.callId === "c1")).toBe(true);

    const toolResults = findEvents<any>(events, "tool:result");
    expect(toolResults.some((r) => r.callId === "c2")).toBe(true);
  });

  // 8. onTools: abort
  it("onTools: abort — run terminates with abort reason", async () => {
    const client = createSingleResponseClient([
      createToolCallDeltaChunk("c1", "echo", '{"message":"hello"}'),
      createFinishChunk("tool_calls", { input: 5, output: 2 }),
    ]);

    const events = await collectEvents(
      agent({
        model: "test",
        systemPrompt: "Use tools",
        messages: [userMessage("test")],
        tools: [echoTool],
        llmClient: client,
        onTools() {
          return { action: "abort", reason: "Not allowed" };
        },
      }),
    );

    const result = getResult(events);
    expect(result!.finishReason).toBe("error");
    expect(result!.error?.code).toBe("INVALID_STATE");
    expect(result!.error?.message).toBe("Not allowed");
  });

  // 9. onTools: pause
  it("onTools: pause — yields pause:approval and generator terminates", async () => {
    const client = createSingleResponseClient([
      createToolCallDeltaChunk("c1", "echo", '{"message":"hello"}'),
      createFinishChunk("tool_calls", { input: 5, output: 2 }),
    ]);

    const events = await collectEvents(
      agent({
        model: "test",
        systemPrompt: "Use tools",
        messages: [userMessage("test")],
        tools: [echoTool],
        llmClient: client,
        onTools() {
          return { action: "pause", callIds: ["c1"], reason: "Need approval" };
        },
      }),
    );

    const pauseEvent = lastEvent<any>(events, "pause:approval");
    expect(pauseEvent).toBeDefined();
    expect(pauseEvent.callIds).toContain("c1");
    // Generator should have terminated (no run:finished, no tool results)
    expect(findEvents(events, "run:finished").length).toBe(0);
  });

  // 10. Tool not found
  it("yields tool:error for unknown tools", async () => {
    const client = createSingleResponseClient([
      createToolCallDeltaChunk("c1", "nonexistent", '{"arg":"val"}'),
      createFinishChunk("tool_calls", { input: 5, output: 2 }),
    ]);

    const events = await collectEvents(
      agent({
        model: "test",
        systemPrompt: "Use tools",
        messages: [userMessage("test")],
        tools: [echoTool],
        llmClient: client,
        maxSteps: 1,
      }),
    );

    const toolErrors = findEvents<any>(events, "tool:error");
    expect(toolErrors.some((e) => e.error.includes("Tool not found"))).toBe(
      true,
    );
  });

  // 11. Tool execution error
  it("tool execution error — yields tool:error", async () => {
    const client = createSingleResponseClient([
      createToolCallDeltaChunk("c1", "fail", '{"reason":"intentional"}'),
      createFinishChunk("tool_calls", { input: 5, output: 2 }),
    ]);

    const events = await collectEvents(
      agent({
        model: "test",
        systemPrompt: "Use tools",
        messages: [userMessage("test")],
        tools: [failingTool],
        llmClient: client,
        maxSteps: 1,
      }),
    );

    const toolErrors = findEvents<any>(events, "tool:error");
    expect(toolErrors.some((e) => e.callId === "c1")).toBe(true);

    const result = getResult(events);
    expect(result!.finishReason).toBe("max_steps");
  });

  // 12. LLM error chunk
  it("yields llm:done with error and run:finished with error", async () => {
    const client = createSingleResponseClient([
      createErrorChunk("Service down"),
    ]);

    const events = await collectEvents(
      agent({
        model: "test",
        systemPrompt: "Be helpful",
        messages: [userMessage("Hi")],
        llmClient: client,
      }),
    );

    const doneEvent = lastEvent<any>(events, "llm:done");
    expect(doneEvent).toBeDefined();
    expect(doneEvent.finishReason).toBe("error");
    expect(doneEvent.error).toBeDefined();

    const result = getResult(events);
    expect(result!.finishReason).toBe("error");
    expect(result!.error?.message).toBe("Service down");
  });

  // 13. Concurrent tools (default)
  it("concurrent tools — yields tool:start together, then results", async () => {
    const client = createMultiStepClient(
      [
        createToolCallDeltaChunk("c1", "echo", '{"message":"a"}'),
        createToolCallDeltaChunk("c2", "greet", '{"name":"b"}'),
        createFinishChunk("tool_calls", { input: 10, output: 5 }),
      ],
      [
        createTextDeltaChunk("Done."),
        createFinishChunk("stop", { input: 2, output: 1 }),
      ],
    );

    const events = await collectEvents(
      agent({
        model: "test",
        systemPrompt: "Use tools",
        messages: [userMessage("test")],
        tools: [echoTool, greetTool],
        llmClient: client,
      }),
    );

    const toolStarts = findEvents<any>(events, "tool:start");
    expect(toolStarts.length).toBe(2);

    const toolResults = findEvents<any>(events, "tool:result");
    expect(toolResults.length).toBe(2);
  });

  // 14. Sequential tools
  it("sequential tools — tools execute one at a time", async () => {
    const client = createMultiStepClient(
      [
        createToolCallDeltaChunk("c1", "echo", '{"message":"a"}'),
        createToolCallDeltaChunk("c2", "greet", '{"name":"b"}'),
        createFinishChunk("tool_calls", { input: 10, output: 5 }),
      ],
      [
        createTextDeltaChunk("Done."),
        createFinishChunk("stop", { input: 2, output: 1 }),
      ],
    );

    const events = await collectEvents(
      agent({
        model: "test",
        systemPrompt: "Use tools",
        messages: [userMessage("test")],
        tools: [echoTool, greetTool],
        llmClient: client,
        toolExecution: "sequential",
      }),
    );

    const toolStarts = findEvents<any>(events, "tool:start");
    expect(toolStarts.length).toBe(2);

    const toolResults = findEvents<any>(events, "tool:result");
    expect(toolResults.length).toBe(2);

    // Check interleaving: start: c1 → result: c1 → start: c2 → result: c2
    const startIdx1 = events.findIndex(
      (e) => e.type === "tool:start" && (e as any).callId === "c1",
    );
    const resultIdx1 = events.findIndex(
      (e) => e.type === "tool:result" && (e as any).callId === "c1",
    );
    const startIdx2 = events.findIndex(
      (e) => e.type === "tool:start" && (e as any).callId === "c2",
    );
    const resultIdx2 = events.findIndex(
      (e) => e.type === "tool:result" && (e as any).callId === "c2",
    );
    expect(startIdx1).toBeLessThan(resultIdx1);
    expect(startIdx2).toBeLessThan(resultIdx2);
    expect(resultIdx1).toBeLessThan(startIdx2);
  });

  // 15. Text accumulation across deltas
  it("correctly accumulates text across multiple text-delta chunks", async () => {
    const client = createSingleResponseClient([
      createTextDeltaChunk("Part "),
      createTextDeltaChunk("1, "),
      createTextDeltaChunk("Part "),
      createTextDeltaChunk("2."),
      createFinishChunk("stop", { input: 10, output: 5 }),
    ]);

    const events = await collectEvents(
      agent({
        model: "test",
        systemPrompt: "Reply",
        messages: [userMessage("Hello")],
        llmClient: client,
      }),
    );

    const result = getResult(events);
    expect(result).toBeDefined();
    expect(result!.text).toContain("Part 1, Part 2.");
  });

  // 16. Token usage tracking
  it("accumulates token usage across steps", async () => {
    const client = createMultiStepClient(
      [
        createToolCallDeltaChunk("c1", "echo", '{"message":"a"}'),
        createFinishChunk("tool_calls", { input: 10, output: 5 }),
      ],
      [
        createTextDeltaChunk("Done."),
        createFinishChunk("stop", { input: 15, output: 3 }),
      ],
    );

    const events = await collectEvents(
      agent({
        model: "test",
        systemPrompt: "Help",
        messages: [userMessage("test")],
        tools: [echoTool],
        llmClient: client,
      }),
    );

    const result = getResult(events);
    expect(result).toBeDefined();
    expect(result!.tokenUsage.input).toBe(25);
    expect(result!.tokenUsage.output).toBe(8);
  });

  // 17. Auto-generated runId when not provided
  it("auto-generates runId when not provided", async () => {
    const client = createSingleResponseClient([
      createTextDeltaChunk("Hello"),
      createFinishChunk("stop"),
    ]);

    const events = await collectEvents(
      agent({
        model: "test",
        systemPrompt: "Be helpful",
        messages: [userMessage("Hi")],
        llmClient: client,
      }),
    );

    const startEvent = lastEvent<any>(events, "run:started");
    expect(startEvent).toBeDefined();
    expect(startEvent.runId).toBeTypeOf("string");
    expect(startEvent.runId.length).toBeGreaterThan(0);
  });
});
