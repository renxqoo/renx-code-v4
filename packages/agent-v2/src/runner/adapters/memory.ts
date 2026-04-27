import type { RunState, RunStatus } from "../../state.js";
import type { AgentEvent } from "../../events.js";
import type { PersistenceAdapter } from "./adapter.js";

/**
 * In-memory persistence adapter for development and testing.
 *
 * Non-persistent, non-concurrent-safe.
 * per DESIGN.md §6.2
 */
export class InMemoryAdapter implements PersistenceAdapter {
  private states = new Map<string, RunState>();
  private events = new Map<string, AgentEvent[]>();
  private leases = new Map<
    string,
    { workerId: string; lockedAt: number }
  >();

  async saveState(state: RunState): Promise<void> {
    this.states.set(state.runId, { ...state });
  }

  async loadState(runId: string): Promise<RunState | null> {
    const state = this.states.get(runId);
    return state ? { ...state } : null;
  }

  async appendEvents(runId: string, events: AgentEvent[]): Promise<void> {
    const existing = this.events.get(runId) ?? [];
    existing.push(...events);
    this.events.set(runId, existing);
  }

  async getEvents(
    runId: string,
    opts?: { offset?: number; limit?: number },
  ): Promise<AgentEvent[]> {
    const all = this.events.get(runId) ?? [];
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? all.length;
    return all.slice(offset, offset + limit);
  }

  async listRuns(filter?: { status?: RunStatus }): Promise<RunState[]> {
    const runs = Array.from(this.states.values());
    if (filter?.status) {
      return runs.filter((r) => r.status === filter.status);
    }
    return runs;
  }

  async deleteRun(runId: string): Promise<void> {
    this.states.delete(runId);
    this.events.delete(runId);
    this.leases.delete(runId);
  }

  async acquirePendingRuns(opts: {
    statuses: RunStatus[];
    workerId: string;
    leaseTtlMs: number;
    batchSize: number;
  }): Promise<RunState[]> {
    const acquired: RunState[] = [];
    const now = Date.now();

    for (const [runId, state] of this.states) {
      if (acquired.length >= opts.batchSize) break;
      if (!opts.statuses.includes(state.status)) continue;

      // Check existing lease
      const lease = this.leases.get(runId);
      if (lease) {
        // Lease expired?
        if (now - lease.lockedAt < 30000) continue; // still locked
        // Lease expired — we can steal it
      }

      // Acquire lease
      this.leases.set(runId, { workerId: opts.workerId, lockedAt: now });
      const updatedState = {
        ...state,
        status: "running" as RunStatus,
        lockedBy: opts.workerId,
        lockedAt: now,
      };
      this.states.set(runId, updatedState);
      acquired.push(updatedState);
    }

    return acquired;
  }

  async renewLease(
    runId: string,
    workerId: string,
    _leaseTtlMs: number,
  ): Promise<boolean> {
    const lease = this.leases.get(runId);
    if (!lease || lease.workerId !== workerId) return false;
    lease.lockedAt = Date.now();
    return true;
  }

  async releaseLease(runId: string, workerId: string): Promise<void> {
    const lease = this.leases.get(runId);
    if (lease && lease.workerId === workerId) {
      this.leases.delete(runId);
      const state = this.states.get(runId);
      if (state) {
        const { lockedBy: _, lockedAt: __, ...rest } = state;
        this.states.set(runId, rest as RunState);
      }
    }
  }

  async getLease(
    runId: string,
  ): Promise<{ workerId: string; lockedAt: number } | null> {
    return this.leases.get(runId) ?? null;
  }
}
