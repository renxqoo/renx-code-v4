/**
 * Telemetry data model per DESIGN.md §6.4.
 */

export type TelemetrySpan = {
  name: string;
  runId: string;
  startTime: number;
  endTime: number;
  parentSpanId?: string;
  attributes: Record<string, string | number | boolean>;
  status: "ok" | "error";
};

export type TelemetryEvent = {
  name: string;
  runId: string;
  timestamp: number;
  attributes: Record<string, string | number | boolean>;
};

export type TelemetrySink = {
  captureSpan: (span: TelemetrySpan) => void;
  captureEvent: (event: TelemetryEvent) => void;
};
