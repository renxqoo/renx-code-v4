import type { Plugin } from "../plugin.js";
import type { AgentInput } from "../types.js";
import type { AgentGenerator } from "../types.js";
import type { TelemetrySink } from "../telemetry/types.js";

/**
 * Telemetry plugin — maps agent events to telemetry spans and events.
 *
 * Mapping (per DESIGN.md §6.4):
 * - run:started    → Span "agent.run" (start)
 * - step:started   → Span "agent.step" (start, parent=run)
 * - llm:delta      → Event "llm.token"
 * - llm:done       → Event "llm.complete" (usage, finishReason)
 * - tool:start     → Span "tool.call" (start, parent=step)
 * - tool:result    → Span "tool.call" (end, durationMs)
 * - tool:error     → Span "tool.call" (end, error)
 * - step:completed → Span "agent.step" (end)
 * - run:finished   → Span "agent.run" (end, totalSteps, totalTokens)
 *
 * Morphology: Event Observer
 */
export function withTelemetry(opts: { sink: TelemetrySink }): Plugin {
  return (inner) =>
    async function* (input: AgentInput): AgentGenerator {
      const runId = input.runId ?? "unknown";

      // Active spans tracked by name for parent/child relationships
      const activeSpans: Record<string, { startTime: number; parentSpanId?: string }> = {};

      for await (const event of inner(input)) {
        switch (event.type) {
          case "run:started": {
            const startTime = Date.now();
            activeSpans["agent.run"] = { startTime };
            // Span start is recorded; end happens on run:finished
            break;
          }
          case "step:started": {
            const startTime = Date.now();
            const parentSpanId = activeSpans["agent.run"]
              ? `${runId}:agent.run`
              : undefined;
            activeSpans[`agent.step:${event.step}`] = {
              startTime,
              parentSpanId,
            };
            break;
          }
          case "llm:delta": {
            opts.sink.captureEvent({
              name: "llm.token",
              runId,
              timestamp: Date.now(),
              attributes: {
                step: event.step,
                deltaLength: event.delta.length,
              },
            });
            break;
          }
          case "llm:done": {
            opts.sink.captureEvent({
              name: "llm.complete",
              runId,
              timestamp: Date.now(),
              attributes: {
                step: event.step,
                finishReason: event.finishReason,
                inputTokens: event.usage.input,
                outputTokens: event.usage.output,
                textLength: event.text?.length ?? 0,
              },
            });
            break;
          }
          case "tool:start": {
            const startTime = Date.now();
            const parentSpanId = activeSpans[`agent.step:${event.name}`]
              ? `${runId}:agent.step`
              : undefined;
            activeSpans[`tool.${event.callId}`] = {
              startTime,
              parentSpanId,
            };
            break;
          }
          case "tool:result": {
            const span = activeSpans[`tool.${event.callId}`];
            if (span) {
              opts.sink.captureSpan({
                name: "tool.call",
                runId,
                startTime: span.startTime,
                endTime: Date.now(),
                parentSpanId: span.parentSpanId,
                attributes: {
                  callId: event.callId,
                  ok: event.ok,
                  durationMs: event.durationMs,
                },
                status: "ok",
              });
              delete activeSpans[`tool.${event.callId}`];
            }
            break;
          }
          case "tool:error": {
            const span = activeSpans[`tool.${event.callId}`];
            if (span) {
              opts.sink.captureSpan({
                name: "tool.call",
                runId,
                startTime: span.startTime,
                endTime: Date.now(),
                parentSpanId: span.parentSpanId,
                attributes: {
                  callId: event.callId,
                  error: event.error,
                },
                status: "error",
              });
              delete activeSpans[`tool.${event.callId}`];
            }
            break;
          }
          case "step:completed": {
            const spanKey = `agent.step:${event.step}`;
            const span = activeSpans[spanKey];
            if (span) {
              opts.sink.captureSpan({
                name: "agent.step",
                runId,
                startTime: span.startTime,
                endTime: Date.now(),
                parentSpanId: span.parentSpanId,
                attributes: {
                  step: event.step,
                  finishReason: event.finishReason,
                  inputTokens: event.tokenUsage.input,
                  outputTokens: event.tokenUsage.output,
                },
                status: "ok",
              });
              delete activeSpans[spanKey];
            }
            break;
          }
          case "run:finished": {
            const span = activeSpans["agent.run"];
            if (span) {
              opts.sink.captureSpan({
                name: "agent.run",
                runId,
                startTime: span.startTime,
                endTime: Date.now(),
                attributes: {
                  finishReason: event.outcome.finishReason,
                  totalSteps: event.outcome.totalSteps,
                  totalInputTokens: event.outcome.tokenUsage.input,
                  totalOutputTokens: event.outcome.tokenUsage.output,
                },
                status:
                  event.outcome.finishReason === "stop" ||
                  event.outcome.finishReason === "handoff"
                    ? "ok"
                    : "error",
              });
              delete activeSpans["agent.run"];
            }
            break;
          }
        }

        yield event;
      }
    };
}
