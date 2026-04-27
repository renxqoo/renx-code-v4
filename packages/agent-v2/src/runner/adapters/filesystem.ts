import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RunState, RunStatus } from "../../state.js";
import type { AgentEvent } from "../../events.js";
import type { PersistenceAdapter } from "./adapter.js";

/**
 * Filesystem persistence adapter for single-node production use.
 *
 * Persists run state and events as JSON files on disk.
 * Not concurrent-safe — use PostgresAdapter for distributed deployments.
 *
 * per DESIGN.md §6.2
 */
export class FileSystemAdapter implements PersistenceAdapter {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private statePath(runId: string): string {
    return path.join(this.baseDir, runId, "state.json");
  }

  private eventsPath(runId: string): string {
    return path.join(this.baseDir, runId, "events.jsonl");
  }

  async saveState(state: RunState): Promise<void> {
    const dir = path.dirname(this.statePath(state.runId));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      this.statePath(state.runId),
      JSON.stringify(state, null, 2),
      "utf-8",
    );
  }

  async loadState(runId: string): Promise<RunState | null> {
    try {
      const data = await fs.readFile(this.statePath(runId), "utf-8");
      return JSON.parse(data) as RunState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  async appendEvents(runId: string, events: AgentEvent[]): Promise<void> {
    const dir = path.dirname(this.eventsPath(runId));
    await fs.mkdir(dir, { recursive: true });
    const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await fs.appendFile(this.eventsPath(runId), lines, "utf-8");
  }

  async getEvents(
    runId: string,
    opts?: { offset?: number; limit?: number },
  ): Promise<AgentEvent[]> {
    try {
      const data = await fs.readFile(this.eventsPath(runId), "utf-8");
      const lines = data
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as AgentEvent);

      const offset = opts?.offset ?? 0;
      const limit = opts?.limit ?? lines.length;
      return lines.slice(offset, offset + limit);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  async listRuns(filter?: { status?: RunStatus }): Promise<RunState[]> {
    try {
      const entries = await fs.readdir(this.baseDir, {
        withFileTypes: true,
      });
      const runs: RunState[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const state = await this.loadState(entry.name);
        if (state) {
          if (!filter?.status || state.status === filter.status) {
            runs.push(state);
          }
        }
      }
      return runs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  async deleteRun(runId: string): Promise<void> {
    const dir = path.join(this.baseDir, runId);
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // Directory may not exist — that's fine
    }
  }

  async acquirePendingRuns(_opts: {
    statuses: RunStatus[];
    workerId: string;
    leaseTtlMs: number;
    batchSize: number;
  }): Promise<RunState[]> {
    // FileSystem adapter doesn't support concurrent leases.
    // Always return empty — use PostgresAdapter for worker deployments.
    return [];
  }

  async renewLease(
    _runId: string,
    _workerId: string,
    _leaseTtlMs: number,
  ): Promise<boolean> {
    return false;
  }

  async releaseLease(_runId: string, _workerId: string): Promise<void> {
    // No-op for single-node adapter
  }

  async getLease(
    _runId: string,
  ): Promise<{ workerId: string; lockedAt: number } | null> {
    return null;
  }
}
