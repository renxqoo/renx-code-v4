import type { HookEventName } from "./hook-types";

export type HookLifecycleEvent =
  | {
      type: "started";
      hookId: string;
      hookName: string;
      event: HookEventName;
      kind: string;
      timestamp: string;
    }
  | {
      type: "progress";
      hookId: string;
      hookName: string;
      event: HookEventName;
      kind: string;
      output: string;
      stdout?: string;
      stderr?: string;
      timestamp: string;
    }
  | {
      type: "completed";
      hookId: string;
      hookName: string;
      event: HookEventName;
      kind: string;
      durationMs: number;
      timestamp: string;
    }
  | {
      type: "failed";
      hookId: string;
      hookName: string;
      event: HookEventName;
      kind: string;
      durationMs: number;
      error: unknown;
      timestamp: string;
    }
  | {
      type: "cancelled";
      hookId: string;
      hookName: string;
      event: HookEventName;
      kind: string;
      durationMs: number;
      timestamp: string;
    }
  | {
      type: "timed_out";
      hookId: string;
      hookName: string;
      event: HookEventName;
      kind: string;
      durationMs: number;
      timeoutMs: number;
      timestamp: string;
    };

export type HookEventHandler = (event: HookLifecycleEvent) => void;

export class HookEventBus {
  private readonly handlers = new Set<HookEventHandler>();
  private readonly pending: HookLifecycleEvent[] = [];
  private readonly maxPending: number;

  constructor(options?: { maxPending?: number }) {
    this.maxPending = options?.maxPending ?? 100;
  }

  subscribe(handler: HookEventHandler): () => void {
    this.handlers.add(handler);
    if (this.pending.length > 0) {
      for (const event of this.pending.splice(0)) {
        handler(event);
      }
    }
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(event: HookLifecycleEvent): void {
    if (this.handlers.size === 0) {
      this.pending.push(event);
      if (this.pending.length > this.maxPending) {
        this.pending.shift();
      }
      return;
    }

    for (const handler of this.handlers) {
      handler(event);
    }
  }

  clear(): void {
    this.handlers.clear();
    this.pending.length = 0;
  }
}
