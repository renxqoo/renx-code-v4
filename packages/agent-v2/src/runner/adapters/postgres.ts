import type { RunState, RunStatus } from "../../state.js";
import type { AgentEvent } from "../../events.js";
import type { PersistenceAdapter } from "./adapter.js";

/**
 * PostgreSQL persistence adapter for distributed production use.
 *
 * Supports concurrent worker processing via SELECT ... FOR UPDATE SKIP LOCKED.
 * Requires a PostgreSQL client (pg or postgres package) to be provided.
 *
 * per DESIGN.md §6.2, §6.3
 */
export interface PostgresClient {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export class PostgresAdapter implements PersistenceAdapter {
  constructor(
    private readonly client: PostgresClient,
    private readonly opts?: {
      tablePrefix?: string;
    },
  ) {}

  private table(name: string): string {
    const prefix = this.opts?.tablePrefix ?? "agent_v2";
    return `${prefix}_${name}`;
  }

  async saveState(state: RunState): Promise<void> {
    await this.client.query(
      `INSERT INTO ${this.table("runs")} (run_id, status, model, system_prompt, messages, working_memory, step_count, token_usage, started_at, last_active_at, locked_by, locked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (run_id) DO UPDATE SET
         status = $2, messages = $5, working_memory = $6,
         step_count = $7, token_usage = $8, last_active_at = $10,
         locked_by = $11, locked_at = $12`,
      [
        state.runId,
        state.status,
        state.model,
        state.systemPrompt,
        JSON.stringify(state.messages),
        JSON.stringify(state.workingMemory),
        state.stepCount,
        JSON.stringify(state.tokenUsage),
        state.startedAt,
        state.lastActiveAt,
        state.lockedBy ?? null,
        state.lockedAt ?? null,
      ],
    );
  }

  async loadState(runId: string): Promise<RunState | null> {
    const result = await this.client.query(
      `SELECT * FROM ${this.table("runs")} WHERE run_id = $1`,
      [runId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0] as Record<string, unknown>;
    return {
      runId: row.run_id as string,
      status: row.status as RunStatus,
      model: row.model as string,
      systemPrompt: row.system_prompt as string,
      messages: JSON.parse(row.messages as string),
      workingMemory: JSON.parse(row.working_memory as string),
      stepCount: row.step_count as number,
      tokenUsage: JSON.parse(row.token_usage as string),
      startedAt: row.started_at as number,
      lastActiveAt: row.last_active_at as number,
      ...(row.locked_by ? { lockedBy: row.locked_by as string } : {}),
      ...(row.locked_at ? { lockedAt: row.locked_at as number } : {}),
    };
  }

  async appendEvents(runId: string, events: AgentEvent[]): Promise<void> {
    for (const event of events) {
      await this.client.query(
        `INSERT INTO ${this.table("events")} (run_id, event_type, payload, created_at)
         VALUES ($1, $2, $3, $4)`,
        [runId, event.type, JSON.stringify(event), Date.now()],
      );
    }
  }

  async getEvents(
    runId: string,
    opts?: { offset?: number; limit?: number },
  ): Promise<AgentEvent[]> {
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 1000;
    const result = await this.client.query(
      `SELECT payload FROM ${this.table("events")}
       WHERE run_id = $1
       ORDER BY created_at ASC
       OFFSET $2 LIMIT $3`,
      [runId, offset, limit],
    );
    return result.rows.map(
      (r) => JSON.parse((r as Record<string, string>).payload) as AgentEvent,
    );
  }

  async listRuns(filter?: { status?: RunStatus }): Promise<RunState[]> {
    let query = `SELECT * FROM ${this.table("runs")}`;
    const params: unknown[] = [];
    if (filter?.status) {
      query += ` WHERE status = $1`;
      params.push(filter.status);
    }
    query += ` ORDER BY started_at DESC`;
    const result = await this.client.query(query, params);
    return result.rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        runId: r.run_id as string,
        status: r.status as RunStatus,
        model: r.model as string,
        systemPrompt: r.system_prompt as string,
        messages: JSON.parse(r.messages as string),
        workingMemory: JSON.parse(r.working_memory as string),
        stepCount: r.step_count as number,
        tokenUsage: JSON.parse(r.token_usage as string),
        startedAt: r.started_at as number,
        lastActiveAt: r.last_active_at as number,
        ...(r.locked_by ? { lockedBy: r.locked_by as string } : {}),
        ...(r.locked_at ? { lockedAt: r.locked_at as number } : {}),
      };
    });
  }

  async deleteRun(runId: string): Promise<void> {
    await this.client.query(
      `DELETE FROM ${this.table("events")} WHERE run_id = $1`,
      [runId],
    );
    await this.client.query(
      `DELETE FROM ${this.table("runs")} WHERE run_id = $1`,
      [runId],
    );
  }

  async acquirePendingRuns(opts: {
    statuses: RunStatus[];
    workerId: string;
    leaseTtlMs: number;
    batchSize: number;
  }): Promise<RunState[]> {
    // Use SELECT ... FOR UPDATE SKIP LOCKED for concurrent lease acquisition
    const statusList = opts.statuses.map((s) => `'${s}'`).join(", ");
    const result = await this.client.query(
      `UPDATE ${this.table("runs")}
       SET status = 'running',
           locked_by = $1,
           locked_at = $2
       WHERE run_id IN (
         SELECT run_id FROM ${this.table("runs")}
         WHERE status IN (${statusList})
           AND (locked_by IS NULL OR locked_at < $3)
         ORDER BY started_at ASC
         LIMIT $4
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [
        opts.workerId,
        Date.now(),
        Date.now() - opts.leaseTtlMs,
        opts.batchSize,
      ],
    );
    return result.rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        runId: r.run_id as string,
        status: "running" as RunStatus,
        model: r.model as string,
        systemPrompt: r.system_prompt as string,
        messages: JSON.parse(r.messages as string),
        workingMemory: JSON.parse(r.working_memory as string),
        stepCount: r.step_count as number,
        tokenUsage: JSON.parse(r.token_usage as string),
        startedAt: r.started_at as number,
        lastActiveAt: Date.now() as number,
        lockedBy: r.locked_by as string,
        lockedAt: r.locked_at as number,
      };
    });
  }

  async renewLease(
    runId: string,
    workerId: string,
    _leaseTtlMs: number,
  ): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE ${this.table("runs")}
       SET locked_at = $1
       WHERE run_id = $2 AND locked_by = $3`,
      [Date.now(), runId, workerId],
    );
    return (result.rows as unknown[]).length > 0;
  }

  async releaseLease(runId: string, workerId: string): Promise<void> {
    await this.client.query(
      `UPDATE ${this.table("runs")}
       SET locked_by = NULL, locked_at = NULL
       WHERE run_id = $1 AND locked_by = $2`,
      [runId, workerId],
    );
  }

  async getLease(
    runId: string,
  ): Promise<{ workerId: string; lockedAt: number } | null> {
    const result = await this.client.query(
      `SELECT locked_by, locked_at FROM ${this.table("runs")} WHERE run_id = $1`,
      [runId],
    );
    if (result.rows.length === 0) return null;
    const r = result.rows[0] as Record<string, unknown>;
    if (!r.locked_by) return null;
    return {
      workerId: r.locked_by as string,
      lockedAt: r.locked_at as number,
    };
  }
}
