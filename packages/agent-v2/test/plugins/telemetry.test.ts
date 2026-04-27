import { describe, it, expect } from "vitest";
import { pipe } from "../../src/plugin.js";
import { withTelemetry } from "../../src/plugins/telemetry.js";
import { agent } from "../../src/agent.js";
import { userMessage } from "../../src/message.js";
import { echoTool } from "../fixtures/mock-tools.js";
import { z } from "zod";
import {
  createSingleResponseClient,
  createMultiStepClient,
  createTextDeltaChunk,
  createToolCallDeltaChunk,
  createFinishChunk,
} from "../fixtures/mock-llm-client.js";
import type { AgentEvent } from "../../src/events.js";
import type { TelemetrySink, TelemetrySpan, TelemetryEvent } from "../../src/telemetry/types.js";

class TestTelemetrySink implements TelemetrySink {
  spans: TelemetrySpan[] = [];
  events: TelemetryEvent[] = [];

  captureSpan(span: TelemetrySpan): void {
    this.spans.push(span);
  }

  captureEvent(event: TelemetryEvent): void {
    this.events.push(event);
  }
}

describe("withTelemetry", () => {
  it("captures agent.run span on run:started and run:finished", async () => {
    const sink = new TestTelemetrySink();

    const fn = pipe(withTelemetry({ sink }), agent);

    const events: AgentEvent[] = [];
    for await (const event of fn({
      model: "test",
      systemPrompt: "Be helpful",
      messages: [userMessage("Hi")],
      runId: "tel-test-1",
      llmClient: createSingleResponseClient([
        createTextDeltaChunk("Hello"),
        createFinishChunk("stop", { input: 5, output: 3 }),
      ]),
    })) {
      events.push(event);
    }

    const runSpan = sink.spans.find(s => s.name === "agent.run");
    expect(runSpan).toBeDefined();
    expect(runSpan!.runId).toBe("tel-test-1");
    expect(runSpan!.status).toBe("ok");
    expect(runSpan!.attributes.finishReason).toBe("stop");
    expect(runSpan!.attributes.totalSteps).toBeTypeOf("number");
  });

  it("captures agent.step span", async () => {
    const sink = new TestTelemetrySink();

    const fn = pipe(withTelemetry({ sink }), agent);

    const events: AgentEvent[] = [];
    for await (const event of fn({
      model: "test",
      systemPrompt: "Be helpful",
      messages: [userMessage("Hi")],
      runId: "tel-step-1",
      llmClient: createSingleResponseClient([
        createTextDeltaChunk("Hello"),
        createFinishChunk("stop", { input: 5, output: 3 }),
      ]),
    })) {
      events.push(event);
    }

    const stepSpan = sink.spans.find(s => s.name === "agent.step");
    expect(stepSpan).toBeDefined();
    expect(stepSpan!.attributes.step).toBe(1);
    expect(stepSpan!.attributes.finishReason).toBe("stop");
  });

  it("captures llm.token and llm.complete events", async () => {
    const sink = new TestTelemetrySink();

    const fn = pipe(withTelemetry({ sink }), agent);

    const events: AgentEvent[] = [];
    for await (const event of fn({
      model: "test",
      systemPrompt: "Be helpful",
      messages: [userMessage("Hi")],
      runId: "tel-llm-1",
      llmClient: createSingleResponseClient([
        createTextDeltaChunk("Hello"),
        createFinishChunk("stop", { input: 5, output: 3 }),
      ]),
    })) {
      events.push(event);
    }

    const tokenEvents = sink.events.filter(e => e.name === "llm.token");
    expect(tokenEvents.length).toBeGreaterThan(0);
    expect(tokenEvents[0]!.attributes.deltaLength).toBe(5);

    const completeEvent = sink.events.find(e => e.name === "llm.complete");
    expect(completeEvent).toBeDefined();
    expect(completeEvent!.attributes.finishReason).toBe("stop");
    expect(completeEvent!.attributes.inputTokens).toBe(5);
    expect(completeEvent!.attributes.outputTokens).toBe(3);
  });

  it("captures tool.call spans", async () => {
    const sink = new TestTelemetrySink();

    const fn = pipe(withTelemetry({ sink }), agent);

    const events: AgentEvent[] = [];
    for await (const event of fn({
      model: "test",
      systemPrompt: "Use tools",
      messages: [userMessage("echo hello")],
      tools: [echoTool],
      runId: "tel-tool-1",
      llmClient: createMultiStepClient(
        [
          createToolCallDeltaChunk("c1", "echo", '{"message":"hello"}'),
          createFinishChunk("tool_calls", { input: 8, output: 4 }),
        ],
        [
          createTextDeltaChunk("Done."),
          createFinishChunk("stop", { input: 2, output: 1 }),
        ],
      ),
    })) {
      events.push(event);
    }

    const toolSpans = sink.spans.filter(s => s.name === "tool.call");
    expect(toolSpans.length).toBeGreaterThan(0);
    const toolSpan = toolSpans[0]!;
    expect(toolSpan.attributes.callId).toBe("c1");
    expect(toolSpan.attributes.ok).toBe(true);
    expect(toolSpan.attributes.durationMs).toBeTypeOf("number");
    expect(toolSpan.status).toBe("ok");
  });

  it("captures tool.call error span on tool:error", async () => {
    const sink = new TestTelemetrySink();

    const fn = pipe(withTelemetry({ sink }), agent);

    const events: AgentEvent[] = [];
    for await (const event of fn({
      model: "test",
      systemPrompt: "Use tools",
      messages: [userMessage("fail")],
      tools: [{
        name: "always_fail",
        description: "Always fails",
        parameters: z.object({ arg: z.string().optional() }),
        execute: async () => { throw new Error("Intentional failure"); },
      }],
      runId: "tel-error-1",
      maxSteps: 1,
      llmClient: createSingleResponseClient([
        createToolCallDeltaChunk("c1", "always_fail", '{"arg":"val"}'),
        createFinishChunk("tool_calls", { input: 8, output: 4 }),
      ]),
    })) {
      events.push(event);
    }

    const errorSpan = sink.spans.find(s => s.name === "tool.call" && s.status === "error");
    expect(errorSpan).toBeDefined();
    expect(errorSpan!.attributes.callId).toBe("c1");
    expect(errorSpan!.attributes.error).toBeDefined();
  });

  it("captures run span as error when finishReason is not stop/handoff", async () => {
    const sink = new TestTelemetrySink();

    const fn = pipe(withTelemetry({ sink }), agent);

    const events: AgentEvent[] = [];
    for await (const event of fn({
      model: "test",
      systemPrompt: "Be helpful",
      messages: [userMessage("Hi")],
      runId: "tel-error-run-1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      llmClient: createSingleResponseClient([
        { type: "error" as any, error: { code: "LLM_UNAVAILABLE", message: "Down", retryable: true } },
      ] as any),
    })) {
      events.push(event);
    }

    const runSpan = sink.spans.find(s => s.name === "agent.run");
    expect(runSpan).toBeDefined();
    expect(runSpan!.status).toBe("error");
  });
});
