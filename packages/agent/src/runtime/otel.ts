import { SpanKind, SpanStatusCode, trace, type Attributes, type Span, type Tracer } from "@opentelemetry/api";
import type { AgentTelemetryEvent, AgentTelemetrySink } from "./telemetry";

export type OpenTelemetrySinkOptions = {
  tracer?: Tracer;
  tracerName?: string;
};

function eventToAttributes(event: AgentTelemetryEvent): Attributes {
  const attrs: Attributes = {
    "agent.event.name": event.name,
  };
  if (event.runId) attrs["agent.run.id"] = event.runId;
  if (event.ownerId) attrs["agent.owner.id"] = event.ownerId;
  if (event.llmRound != null) attrs["agent.llm.round"] = event.llmRound;
  if (event.status) attrs["agent.run.status"] = event.status;
  if (event.finishReason) attrs["agent.finish_reason"] = event.finishReason;
  if (event.durationMs != null) attrs["agent.duration_ms"] = event.durationMs;
  if (event.toolCount != null) attrs["agent.tool_count"] = event.toolCount;
  if (event.success != null) attrs["agent.success"] = event.success;
  if (event.metadata) {
    for (const [key, value] of Object.entries(event.metadata)) {
      const attrKey = `agent.meta.${key}`;
      if (value == null) continue;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        attrs[attrKey] = value;
      } else {
        attrs[attrKey] = JSON.stringify(value);
      }
    }
  }
  return attrs;
}

function markSpan(span: Span, event: AgentTelemetryEvent): void {
  if (event.success === false) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: event.metadata?.error != null ? String(event.metadata.error) : `${event.name} failed`,
    });
    return;
  }
  span.setStatus({ code: SpanStatusCode.OK });
}

export class OpenTelemetrySink implements AgentTelemetrySink {
  private readonly tracer: Tracer;

  constructor(options: OpenTelemetrySinkOptions = {}) {
    this.tracer = options.tracer ?? trace.getTracer(options.tracerName ?? "@renx/agent");
  }

  async capture(event: AgentTelemetryEvent): Promise<void> {
    const span = this.tracer.startSpan(`agent.${event.name}`, {
      kind: SpanKind.INTERNAL,
      startTime: new Date(event.at),
      attributes: eventToAttributes(event),
    });
    markSpan(span, event);
    span.end();
  }
}
