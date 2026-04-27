import type { AgentFn } from "../types.js";
import type { RunStatus } from "../state.js";
import type { PersistenceAdapter } from "./adapters/adapter.js";
import { InMemoryAdapter } from "./adapters/memory.js";
import { getRunManager } from "./manager.js";
import { generateId } from "../utils/id.js";

/**
 * Worker configuration for polling and executing agent runs.
 *
 * per DESIGN.md §6.3
 */
export type WorkerConfig = {
  agent: AgentFn;
  adapter?: PersistenceAdapter;
  pollIntervalMs?: number;
  batchSize?: number;
  statuses?: RunStatus[];
  workerId?: string;
  leaseTtlMs?: number;
  leaseRenewIntervalMs?: number;
};

/**
 * Worker interface for starting, polling, and stopping background processing.
 */
export interface Worker {
  start: (signal?: AbortSignal) => Promise<void>;
  poll: () => Promise<void>;
  stop: () => void;
}

/**
 * Create a worker that polls for pending runs and executes them.
 *
 * The worker repeatedly checks the persistence adapter for runs
 * with the configured statuses, acquires leases, and processes them.
 *
 * Lease protocol:
 * 1. Query runs with target statuses and no lock / expired lock
 * 2. Acquire lease atomically (adapter.acquirePendingRuns)
 * 3. Execute agent loop for each acquired run
 * 4. Periodically renew lease (adapter.renewLease)
 * 5. On completion: release lease, set final status
 * 6. On crash: other workers detect expired locked_at and steal lease
 *
 * per DESIGN.md §6.3
 */
export function createWorker(config: WorkerConfig): Worker {
  const workerId = config.workerId ?? generateId();
  const pollIntervalMs = config.pollIntervalMs ?? 500;
  const batchSize = config.batchSize ?? 10;
  const statuses = config.statuses ?? ["ready" as RunStatus];
  const leaseTtlMs = config.leaseTtlMs ?? 30000;
  const leaseRenewIntervalMs =
    config.leaseRenewIntervalMs ?? Math.floor(leaseTtlMs / 2);
  const adapter =
    config.adapter ?? new InMemoryAdapter();
  const agentFn = config.agent;

  let running = false;
  let stopRequested = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  async function poll(): Promise<void> {
    if (stopRequested) return;

    try {
      const pendingRuns = await adapter.acquirePendingRuns({
        statuses,
        workerId,
        leaseTtlMs,
        batchSize,
      });

      if (pendingRuns.length === 0) return;

      // Process each acquired run concurrently
      for (const runState of pendingRuns) {
        // Process in background (non-blocking for other runs)
        processRun(runState.runId).catch(() => {
          // Errors are handled inside processRun
        });
      }
    } catch (_err) {
      // Poll errors should not crash the worker
    }
  }

  async function processRun(runId: string): Promise<void> {
    // Set up lease renewal interval
    const leaseTimer = setInterval(async () => {
      const renewed = await adapter.renewLease(
        runId,
        workerId,
        leaseTtlMs,
      );
      if (!renewed) {
        // Lost lease — another worker took over
        clearInterval(leaseTimer);
      }
    }, leaseRenewIntervalMs);

    try {
      const manager = getRunManager(agentFn, adapter);
      const run = await manager.resume(runId);

      // Stream all events to completion
      for await (const _event of run.stream()) {
        // Events are persisted by the RunManager
        // Check if we should stop
        if (stopRequested) break;
      }
    } catch (_err) {
      // Run processing errors are captured in adapter events
    } finally {
      clearInterval(leaseTimer);
      // Always release the lease
      await adapter.releaseLease(runId, workerId);
    }
  }

  function schedulePoll() {
    if (stopRequested || !running) return;
    pollTimer = setTimeout(async () => {
      await poll();
      schedulePoll();
    }, pollIntervalMs);
  }

  return {
    async start(signal?: AbortSignal): Promise<void> {
      running = true;
      stopRequested = false;

      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            stopRequested = true;
            running = false;
            if (pollTimer) clearTimeout(pollTimer);
          },
          { once: true },
        );
      }

      // Immediate first poll
      await poll();
      // Then schedule recurring polls
      schedulePoll();
    },

    poll,

    stop(): void {
      stopRequested = true;
      running = false;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = undefined;
      }
    },
  };
}
