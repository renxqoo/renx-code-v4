import type { TelemetrySink, TelemetrySpan, TelemetryEvent } from "./types.js";

/**
 * OpenTelemetry telemetry sink.
 *
 * This is a stub that delegates to a real OTel SDK if available.
 * To use, pass a properly configured OTel SpanExporter / TracerProvider.
 *
 * In production, install @opentelemetry/sdk-trace-node and wire up:
 *
 *   const otel = new OpenTelemetrySink({
 *     tracerProvider: new NodeTracerProvider(),
 *     exporter: new ConsoleSpanExporter(),
 *   });
 */
export class OpenTelemetrySink implements TelemetrySink {
  constructor(
    private readonly opts?: {
      /**
       * OTel TracerProvider-compatible object.
       * Must have `getTracer(name, version)` method.
       */
      tracerProvider?: {
        getTracer: (
          name: string,
          version?: string,
        ) => { startSpan: (name: string) => SpanLike };
      };
    },
  ) {}

  captureSpan(span: TelemetrySpan): void {
    if (this.opts?.tracerProvider) {
      const tracer = this.opts.tracerProvider.getTracer(
        "@renx/agent-v2",
        "0.1.0",
      );
      const otelSpan = tracer.startSpan(span.name);
      Object.entries(span.attributes).forEach(([k, v]) => {
        otelSpan.setAttribute(k, v);
      });
      if (span.status === "error") {
        otelSpan.setStatus({ code: 2 }); // Error
      } else {
        otelSpan.setStatus({ code: 1 }); // Ok
      }
      otelSpan.end(span.endTime);
    }
  }

  captureEvent(_event: TelemetryEvent): void {
    // OTel events are typically captured as span events.
    // Stub implementation — wire up in production.
  }
}

interface SpanLike {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number }): void;
  end(time?: number): void;
}
