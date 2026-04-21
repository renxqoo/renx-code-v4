import { describe, expect, it, vi } from "vitest";
import { OpenTelemetrySink } from "./otel";
import type { AgentTelemetryEvent } from "./telemetry";

describe("OpenTelemetrySink", () => {
  it("translates telemetry events into spans with attributes", async () => {
    const end = vi.fn();
    const setStatus = vi.fn();
    const tracer = {
      startSpan: vi.fn().mockReturnValue({
        end,
        setStatus,
      }),
    };
    const sink = new OpenTelemetrySink({ tracer: tracer as never });

    const event: AgentTelemetryEvent = {
      name: "tool_completed",
      at: "2026-04-21T00:00:00.000Z",
      runId: "run-1",
      llmRound: 2,
      durationMs: 42,
      toolCount: 1,
      success: true,
      metadata: { tools: ["lookup_customer"] },
    };

    await sink.capture(event);

    expect(tracer.startSpan).toHaveBeenCalledOnce();
    const [name, options] = tracer.startSpan.mock.calls[0];
    expect(name).toBe("agent.tool_completed");
    expect(options.attributes["agent.run.id"]).toBe("run-1");
    expect(options.attributes["agent.tool_count"]).toBe(1);
    expect(setStatus).toHaveBeenCalled();
    expect(end).toHaveBeenCalled();
  });

  it("marks unsuccessful events as errored spans", async () => {
    const setStatus = vi.fn();
    const tracer = {
      startSpan: vi.fn().mockReturnValue({
        end: vi.fn(),
        setStatus,
      }),
    };
    const sink = new OpenTelemetrySink({ tracer: tracer as never });

    await sink.capture({
      name: "worker_error",
      at: "2026-04-21T00:00:00.000Z",
      success: false,
      metadata: { error: "boom" },
    });

    expect(setStatus.mock.calls[0][0].message).toContain("boom");
  });
});
