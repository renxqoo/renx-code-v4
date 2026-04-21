import type { Pool, PoolClient } from "pg";
import { cloneContextValue } from "../agent/clone";
import type {
  AgentEventQuery,
  AgentRunLease,
  AgentRunQuery,
  AgentRunRecord,
  AgentRuntimeEvent,
  AgentSessionStore,
} from "./session-store";

type PostgresQueryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export type PostgresSessionStoreOptions = {
  db: PostgresQueryable;
  schema?: string;
};

type JsonRow = {
  record?: AgentRunRecord;
  event?: AgentRuntimeEvent;
  run_id?: string;
  owner_id?: string;
  acquired_at?: Date | string;
  expires_at?: Date | string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (Object.prototype.toString.call(value) !== "[object Object]") {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serializeError(error: Error): Record<string, unknown> {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    cause: error.cause == null ? undefined : toSerializableValue(error.cause),
  };
}

function toSerializableValue<T>(value: T): T {
  if (value == null) return value;
  if (value instanceof Error) return serializeError(value) as T;
  if (Array.isArray(value)) return value.map((entry) => toSerializableValue(entry)) as T;
  if (value instanceof Date) return new Date(value.getTime()).toISOString() as T;
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].map(([key, entry]) => [String(key), toSerializableValue(entry)]),
    ) as T;
  }
  if (value instanceof Set) return [...value].map((entry) => toSerializableValue(entry)) as T;
  if (typeof value === "object" && isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = toSerializableValue(entry);
    }
    return out as T;
  }
  return cloneContextValue(value);
}

function assertSqlIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid SQL identifier: ${value}`);
  }
  return value;
}

export class PostgresSessionStore implements AgentSessionStore {
  private readonly db: PostgresQueryable;
  private readonly schema: string;

  constructor(options: PostgresSessionStoreOptions) {
    this.db = options.db;
    this.schema = assertSqlIdentifier(options.schema ?? "agent_runtime");
  }

  async init(): Promise<void> {
    await this.db.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS ${this.schema}.runs (
        run_id TEXT PRIMARY KEY,
        record JSONB NOT NULL
      )
    `);
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS ${this.schema}.events (
        seq BIGSERIAL PRIMARY KEY,
        run_id TEXT NOT NULL,
        event JSONB NOT NULL
      )
    `);
    await this.db.query(`
      CREATE INDEX IF NOT EXISTS ${this.schema}_events_run_id_seq_idx
      ON ${this.schema}.events (run_id, seq)
    `);
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS ${this.schema}.leases (
        run_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        acquired_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      )
    `);
  }

  async createRun(run: AgentRunRecord): Promise<void> {
    await this.saveRun(run);
  }

  async saveRun(run: AgentRunRecord): Promise<void> {
    await this.db.query(
      `
        INSERT INTO ${this.schema}.runs (run_id, record)
        VALUES ($1, $2::jsonb)
        ON CONFLICT (run_id) DO UPDATE SET record = EXCLUDED.record
      `,
      [run.runId, JSON.stringify(toSerializableValue(run))],
    );
  }

  async getRun(runId: string): Promise<AgentRunRecord | null> {
    const result = await this.db.query(
      `SELECT record FROM ${this.schema}.runs WHERE run_id = $1`,
      [runId],
    );
    const row = (result.rows[0] ?? null) as JsonRow | null;
    return row?.record ? cloneContextValue(row.record) : null;
  }

  async listRuns(query?: AgentRunQuery): Promise<AgentRunRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query?.statuses?.length) {
      params.push(query.statuses);
      clauses.push(`record->>'status' = ANY($${params.length})`);
    }
    params.push(Math.max(0, query?.offset ?? 0));
    const offsetParam = `$${params.length}`;
    params.push(Math.max(0, query?.limit ?? 100));
    const limitParam = `$${params.length}`;
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await this.db.query(
      `
        SELECT record
        FROM ${this.schema}.runs
        ${whereSql}
        ORDER BY record->>'createdAt' ASC
        OFFSET ${offsetParam}
        LIMIT ${limitParam}
      `,
      params,
    );
    return (result.rows as JsonRow[])
      .map((row: JsonRow) => row.record)
      .filter((run: AgentRunRecord | undefined): run is AgentRunRecord => run != null)
      .map((run: AgentRunRecord) => cloneContextValue(run));
  }

  async appendEvents(runId: string, events: AgentRuntimeEvent[]): Promise<void> {
    if (events.length === 0) return;
    const values: string[] = [];
    const params: unknown[] = [];
    for (const event of events) {
      params.push(runId, JSON.stringify(toSerializableValue(event)));
      values.push(`($${params.length - 1}, $${params.length}::jsonb)`);
    }
    await this.db.query(
      `INSERT INTO ${this.schema}.events (run_id, event) VALUES ${values.join(", ")}`,
      params,
    );
  }

  async listEvents(runId: string, query?: AgentEventQuery): Promise<AgentRuntimeEvent[]> {
    const offset = Math.max(0, query?.offset ?? 0);
    const limit = query?.limit;
    const params: unknown[] = [runId, offset];
    let limitSql = "";
    if (limit != null) {
      params.push(Math.max(0, limit));
      limitSql = `LIMIT $${params.length}`;
    }
    const result = await this.db.query(
      `
        SELECT event
        FROM ${this.schema}.events
        WHERE run_id = $1
        ORDER BY seq ASC
        OFFSET $2
        ${limitSql}
      `,
      params,
    );
    return (result.rows as JsonRow[])
      .map((row: JsonRow) => row.event)
      .filter((event: AgentRuntimeEvent | undefined): event is AgentRuntimeEvent => event != null)
      .map((event: AgentRuntimeEvent) => cloneContextValue(event));
  }

  async getLease(runId: string): Promise<AgentRunLease | null> {
    await this.deleteExpiredLease(runId);
    const result = await this.db.query(
      `SELECT run_id, owner_id, acquired_at, expires_at FROM ${this.schema}.leases WHERE run_id = $1`,
      [runId],
    );
    return this.rowToLease(result.rows[0] as JsonRow | undefined);
  }

  async acquireLease(runId: string, ownerId: string, ttlMs: number): Promise<AgentRunLease | null> {
    await this.deleteExpiredLease(runId);
    const result = await this.db.query(
      `
        INSERT INTO ${this.schema}.leases (run_id, owner_id, acquired_at, expires_at)
        VALUES ($1, $2, NOW(), NOW() + ($3 || ' milliseconds')::interval)
        ON CONFLICT (run_id) DO UPDATE
        SET owner_id = EXCLUDED.owner_id,
            acquired_at = ${this.schema}.leases.acquired_at,
            expires_at = EXCLUDED.expires_at
        WHERE ${this.schema}.leases.owner_id = EXCLUDED.owner_id
        RETURNING run_id, owner_id, acquired_at, expires_at
      `,
      [runId, ownerId, Math.max(1, ttlMs)],
    );
    return this.rowToLease(result.rows[0] as JsonRow | undefined);
  }

  async renewLease(runId: string, ownerId: string, ttlMs: number): Promise<AgentRunLease | null> {
    const result = await this.db.query(
      `
        UPDATE ${this.schema}.leases
        SET expires_at = NOW() + ($3 || ' milliseconds')::interval
        WHERE run_id = $1 AND owner_id = $2 AND expires_at > NOW()
        RETURNING run_id, owner_id, acquired_at, expires_at
      `,
      [runId, ownerId, Math.max(1, ttlMs)],
    );
    return this.rowToLease(result.rows[0] as JsonRow | undefined);
  }

  async releaseLease(runId: string, ownerId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM ${this.schema}.leases WHERE run_id = $1 AND owner_id = $2`,
      [runId, ownerId],
    );
  }

  private async deleteExpiredLease(runId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM ${this.schema}.leases WHERE run_id = $1 AND expires_at <= NOW()`,
      [runId],
    );
  }

  private rowToLease(row?: JsonRow): AgentRunLease | null {
    if (!row?.run_id || !row.owner_id || !row.acquired_at || !row.expires_at) {
      return null;
    }
    return {
      runId: row.run_id,
      ownerId: row.owner_id,
      acquiredAt: new Date(row.acquired_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
    };
  }
}
