import { describe, expect, it } from "vitest";

import { HookEventBus } from "./hook-events";

describe("hook-events", () => {
  it("buffers events until a subscriber attaches", () => {
    const bus = new HookEventBus();
    const received: string[] = [];

    bus.emit({
      type: "started",
      hookId: "h1",
      hookName: "hook",
      event: "beforeRun",
      kind: "callback",
      timestamp: new Date().toISOString(),
    });

    bus.subscribe((event) => {
      received.push(event.type);
    });

    expect(received).toEqual(["started"]);
  });

  it("caps pending events by maxPending and supports unsubscribe and clear", () => {
    const bus = new HookEventBus({ maxPending: 2 });
    const pendingTypes: string[] = [];
    const liveTypes: string[] = [];

    bus.emit({
      type: "started",
      hookId: "1",
      hookName: "one",
      event: "beforeRun",
      kind: "callback",
      timestamp: new Date().toISOString(),
    });
    bus.emit({
      type: "failed",
      hookId: "2",
      hookName: "two",
      event: "beforeRun",
      kind: "callback",
      durationMs: 1,
      error: new Error("boom"),
      timestamp: new Date().toISOString(),
    });
    bus.emit({
      type: "completed",
      hookId: "3",
      hookName: "three",
      event: "beforeRun",
      kind: "callback",
      durationMs: 2,
      timestamp: new Date().toISOString(),
    });

    const unsubscribe = bus.subscribe((event) => {
      pendingTypes.push(event.type);
      liveTypes.push(event.type);
    });

    expect(pendingTypes).toEqual(["failed", "completed"]);

    bus.emit({
      type: "cancelled",
      hookId: "4",
      hookName: "four",
      event: "beforeRun",
      kind: "callback",
      durationMs: 3,
      timestamp: new Date().toISOString(),
    });

    expect(liveTypes).toContain("cancelled");

    unsubscribe();
    bus.emit({
      type: "timed_out",
      hookId: "5",
      hookName: "five",
      event: "beforeRun",
      kind: "callback",
      durationMs: 4,
      timeoutMs: 4,
      timestamp: new Date().toISOString(),
    });

    bus.clear();

    const afterClear: string[] = [];
    bus.subscribe((event) => {
      afterClear.push(event.type);
    });

    expect(afterClear).toEqual([]);
  });
});
