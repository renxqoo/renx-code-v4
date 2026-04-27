import type { TelemetrySink, TelemetrySpan, TelemetryEvent } from "./types.js";

/**
 * Console-based telemetry sink for debugging and development.
 * Outputs spans and events to stdout as JSON.
 */
export class ConsoleSink implements TelemetrySink {
  constructor(
    private readonly opts?: {
      /** Only log these span names (filter). Logs all if unset. */
      spanFilter?: string[];
      /** Only log these event names (filter). Logs all if unset. */
      eventFilter?: string[];
    },
  ) {}

  captureSpan(span: TelemetrySpan): void {
    if (this.opts?.spanFilter && !this.opts.spanFilter.includes(span.name)) {
      return;
    }
    process.stdout.write(
      `[telemetry:span] ${span.name} (${span.status}) ` +
        `${span.endTime - span.startTime}ms\n` +
        JSON.stringify(span.attributes) +
        "\n",
    );
  }

  captureEvent(event: TelemetryEvent): void {
    if (
      this.opts?.eventFilter &&
      !this.opts.eventFilter.includes(event.name)
    ) {
      return;
    }
    process.stdout.write(
      `[telemetry:event] ${event.name} ` +
        JSON.stringify(event.attributes) +
        "\n",
    );
  }
}
