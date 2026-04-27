import type { RunState, RunStatus } from "../../state.js";
import type { AgentEvent } from "../../events.js";

/**
 * Persistence adapter interface for RunManager.
 *
 * Supports state persistence, event storage, worker leases,
 * and cross-process concurrent run coordination.
 *
 * per DESIGN.md §6.2
 */
export interface PersistenceAdapter {
  /** Save or update a run state */
  saveState(state: RunState): Promise<void>;

  /** Load a run state by ID */
  loadState(runId: string): Promise<RunState | null>;

  /** Append events to a run's event log */
  appendEvents(runId: string, events: AgentEvent[]): Promise<void>;

  /** Get events for a run, with optional pagination */
  getEvents(
    runId: string,
    opts?: { offset?: number; limit?: number },
  ): Promise<AgentEvent[]>;

  /** List runs, optionally filtered by status */
  listRuns(filter?: { status?: RunStatus }): Promise<RunState[]>;

  /** Delete a run and its events */
  deleteRun(runId: string): Promise<void>;

  /** Acquire pending runs for worker processing (lease-based) */
  acquirePendingRuns(opts: {
    statuses: RunStatus[];
    workerId: string;
    leaseTtlMs: number;
    batchSize: number;
  }): Promise<RunState[]>;

  /** Renew an existing lease */
  renewLease(
    runId: string,
    workerId: string,
    leaseTtlMs: number,
  ): Promise<boolean>;

  /** Release a lease */
  releaseLease(runId: string, workerId: string): Promise<void>;

  /** Get current lease info for a run */
  getLease(
    runId: string,
  ): Promise<{ workerId: string; lockedAt: number } | null>;
}
