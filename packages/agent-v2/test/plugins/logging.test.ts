import { describe, it, expect } from "vitest";
import { pipe } from "../../src/plugin.js";
import { withLogging } from "../../src/plugins/logging.js";
import { agent } from "../../src/agent.js";
import { userMessage } from "../../src/message.js";
import { echoTool } from "../fixtures/mock-tools.js";
import {
  createSingleResponseClient,
  createTextDeltaChunk,
  createToolCallDeltaChunk,
  createFinishChunk,
} from "../fixtures/mock-llm-client.js";
import type { AgentGenerator, AgentInput } from "../../src/index.js";
import type { Logger } from "../../src/utils/logger.js";

async function runAgent(fn: (input: AgentInput) => AgentGenerator): Promise<void> {
  for await (const _ of fn({
    model: "test",
    systemPrompt: "Be helpful",
    messages: [userMessage("Hi")],
    llmClient: createSingleResponseClient([
      createTextDeltaChunk("Hello"),
      createFinishChunk("stop"),
    ]),
  })) { /* consume */ }
}

function createTestLogger(): Logger & { calls: Array<{ level: string; message: string; meta?: Record<string, unknown> }> } {
  const calls: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = [];
  return {
    calls,
    debug(message, meta) { calls.push({ level: "debug", message, meta }); },
    info(message, meta) { calls.push({ level: "info", message, meta }); },
    warn(message, meta) { calls.push({ level: "warn", message, meta }); },
    error(message, meta) { calls.push({ level: "error", message, meta }); },
  };
}

describe("withLogging", () => {
  it("logs agent:start, agent:event, and agent:end events", async () => {
    const logger = createTestLogger();

    await runAgent(
      pipe(withLogging({ logger }), agent),
    );

    expect(logger.calls.some(c => c.message === "agent:start")).toBe(true);
    expect(logger.calls.some(c => c.message === "agent:event")).toBe(true);
    expect(logger.calls.some(c => c.message === "agent:end")).toBe(true);
  });

  it("logs runId in agent:start metadata", async () => {
    const logger = createTestLogger();

    await runAgent(
      pipe(withLogging({ logger }), agent),
    );

    const startCall = logger.calls.find(c => c.message === "agent:start");
    expect(startCall).toBeDefined();
    expect(startCall!.meta).toBeDefined();
    expect(startCall!.meta!.runId).toBeTypeOf("string");
  });

  it("logs runId in agent:end metadata", async () => {
    const logger = createTestLogger();

    await runAgent(
      pipe(withLogging({ logger }), agent),
    );

    const endCall = logger.calls.find(c => c.message === "agent:end");
    expect(endCall).toBeDefined();
    expect(endCall!.meta).toBeDefined();
    expect(endCall!.meta!.runId).toBeTypeOf("string");
    expect(endCall!.meta!.durationMs).toBeTypeOf("number");
  });

  it("skips llm:delta events by default (includeDelta=false)", async () => {
    const logger = createTestLogger();

    await runAgent(
      pipe(withLogging({ logger }), agent),
    );

    const deltaCalls = logger.calls.filter(
      c => c.message === "agent:event" && c.meta?.eventType === "llm:delta"
    );
    expect(deltaCalls.length).toBe(0);
  });

  it("includes llm:delta events when includeDelta=true", async () => {
    const logger = createTestLogger();

    await runAgent(
      pipe(withLogging({ logger, includeDelta: true }), agent),
    );

    const deltaCalls = logger.calls.filter(
      c => c.message === "agent:event" && c.meta?.eventType === "llm:delta"
    );
    expect(deltaCalls.length).toBeGreaterThan(0);
  });

  it("logs tool:start with tool name", async () => {
    const logger = createTestLogger();

    for await (const _ of pipe(withLogging({ logger }), agent)({
      model: "test",
      systemPrompt: "Use tools",
      messages: [userMessage("echo hello")],
      tools: [echoTool],
      llmClient: createSingleResponseClient([
        createToolCallDeltaChunk("c1", "echo", '{"message":"hello"}'),
        createFinishChunk("tool_calls"),
      ]),
    })) { /* consume */ }

    const toolStartCalls = logger.calls.filter(
      c => c.message === "agent:event" && c.meta?.eventType === "tool:start"
    );
    expect(toolStartCalls.length).toBeGreaterThan(0);
    expect(toolStartCalls[0]!.meta!.toolName).toBe("echo");
  });

  it("logs tool:result with ok and durationMs", async () => {
    const logger = createTestLogger();

    for await (const _ of pipe(withLogging({ logger }), agent)({
      model: "test",
      systemPrompt: "Use tools",
      messages: [userMessage("echo hello")],
      tools: [echoTool],
      llmClient: createSingleResponseClient([
        createToolCallDeltaChunk("c1", "echo", '{"message":"hello"}'),
        createFinishChunk("tool_calls"),
      ]),
    })) { /* consume */ }

    const resultCalls = logger.calls.filter(
      c => c.message === "agent:event" && c.meta?.eventType === "tool:result"
    );
    expect(resultCalls.length).toBeGreaterThan(0);
    expect(resultCalls[0]!.meta!.ok).toBe(true);
    expect(resultCalls[0]!.meta!.durationMs).toBeTypeOf("number");
  });

  it("logs llm:done with finishReason and usage", async () => {
    const logger = createTestLogger();

    await runAgent(
      pipe(withLogging({ logger }), agent),
    );

    const doneCalls = logger.calls.filter(
      c => c.message === "agent:event" && c.meta?.eventType === "llm:done"
    );
    expect(doneCalls.length).toBeGreaterThan(0);
    expect(doneCalls[0]!.meta!.finishReason).toBe("stop");
    expect(doneCalls[0]!.meta!.usage).toBeDefined();
  });

  it("supports info log level", async () => {
    const logger = createTestLogger();

    await runAgent(
      pipe(withLogging({ logger, level: "info" }), agent),
    );

    const startCall = logger.calls.find(c => c.message === "agent:start");
    expect(startCall!.level).toBe("info");
  });

  it("logs errors when inner agent throws", async () => {
    const logger = createTestLogger();

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for await (const _ of pipe(withLogging({ logger }), (async function* () {
        throw new Error("test error");
      }) as any)({} as any)) {
        /* never reached */
      }
    } catch {
      // expected
    }

    const errorCalls = logger.calls.filter(c => c.level === "error");
    expect(errorCalls.length).toBeGreaterThan(0);
    expect(errorCalls[0]!.message).toBe("agent:error");
  });
});
