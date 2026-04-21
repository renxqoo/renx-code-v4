import { describe, expect, it } from "vitest";
import { PostgresSessionStore } from "./postgres-session-store";
import type { AgentRunLease, AgentRunRecord, AgentRuntimeEvent } from "./session-store";

type QueryResultRow = Record<string, unknown>;

class MockPostgresDb {
  private readonly runs = new Map<string, AgentRunRecord>();
  private readonly events = new Map<string, AgentRuntimeEvent[]>();
  private readonly leases = new Map<string, AgentRunLease>();

  async query(sql: string, params: unknown[] = []): Promise<{ rows: QueryResultRow[] }> {
    if (sql.includes("CREATE SCHEMA") || sql.includes("CREATE TABLE") || sql.includes("CREATE INDEX")) {
      return { rows: [] };
    }
    if (sql.includes("INSERT INTO agent_runtime.runs")) {
      const [runId, record] = params as [string, string];
      this.runs.set(runId, JSON.parse(record) as AgentRunRecord);
      return { rows: [] };
    }
    if (sql.includes("SELECT record FROM agent_runtime.runs WHERE run_id =")) {
      const [runId] = params as [string];
      const record = this.runs.get(runId);
      return { rows: record ? [{ record }] : [] };
    }
    if (sql.includes("SELECT record") && sql.includes("FROM agent_runtime.runs")) {
      const statuses = Array.isArray(params[0]) ? (params[0] as string[]) : undefined;
      const offset = Number(params[statuses ? 1 : 0] ?? 0);
      const limit = Number(params[statuses ? 2 : 1] ?? 100);
      const runs = [...this.runs.values()]
        .filter((run) => !statuses || statuses.includes(run.status))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(offset, offset + limit)
        .map((record) => ({ record }));
      return { rows: runs };
    }
    if (sql.includes("INSERT INTO agent_runtime.events")) {
      for (let index = 0; index < params.length; index += 2) {
        const runId = params[index] as string;
        const event = JSON.parse(params[index + 1] as string) as AgentRuntimeEvent;
        const current = this.events.get(runId) ?? [];
        current.push(event);
        this.events.set(runId, current);
      }
      return { rows: [] };
    }
    if (sql.includes("SELECT event") && sql.includes("FROM agent_runtime.events")) {
      const [runId, offset, maybeLimit] = params as [string, number, number | undefined];
      const events = (this.events.get(runId) ?? [])
        .slice(offset, maybeLimit == null ? undefined : offset + maybeLimit)
        .map((event) => ({ event }));
      return { rows: events };
    }
    if (sql.includes("DELETE FROM agent_runtime.leases") && sql.includes("expires_at <= NOW()")) {
      const [runId] = params as [string];
      const lease = this.leases.get(runId);
      if (lease && Date.parse(lease.expiresAt) <= Date.now()) {
        this.leases.delete(runId);
      }
      return { rows: [] };
    }
    if (sql.includes("SELECT run_id, owner_id, acquired_at, expires_at FROM agent_runtime.leases")) {
      const [runId] = params as [string];
      const lease = this.leases.get(runId);
      return {
        rows: lease
          ? [
              {
                run_id: lease.runId,
                owner_id: lease.ownerId,
                acquired_at: lease.acquiredAt,
                expires_at: lease.expiresAt,
              },
            ]
          : [],
      };
    }
    if (sql.includes("INSERT INTO agent_runtime.leases")) {
      const [runId, ownerId, ttlMs] = params as [string, string, number];
      const current = this.leases.get(runId);
      if (current && current.ownerId !== ownerId && Date.parse(current.expiresAt) > Date.now()) {
        return { rows: [] };
      }
      const now = new Date();
      const lease: AgentRunLease = {
        runId,
        ownerId,
        acquiredAt: current?.acquiredAt ?? now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      };
      this.leases.set(runId, lease);
      return {
        rows: [
          {
            run_id: lease.runId,
            owner_id: lease.ownerId,
            acquired_at: lease.acquiredAt,
            expires_at: lease.expiresAt,
          },
        ],
      };
    }
    if (sql.includes("UPDATE agent_runtime.leases")) {
      const [runId, ownerId, ttlMs] = params as [string, string, number];
      const current = this.leases.get(runId);
      if (!current || current.ownerId !== ownerId || Date.parse(current.expiresAt) <= Date.now()) {
        return { rows: [] };
      }
      const renewed: AgentRunLease = {
        ...current,
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      };
      this.leases.set(runId, renewed);
      return {
        rows: [
          {
            run_id: renewed.runId,
            owner_id: renewed.ownerId,
            acquired_at: renewed.acquiredAt,
            expires_at: renewed.expiresAt,
          },
        ],
      };
    }
    if (sql.includes("DELETE FROM agent_runtime.leases WHERE run_id =") && sql.includes("owner_id =")) {
      const [runId, ownerId] = params as [string, string];
      const current = this.leases.get(runId);
      if (current?.ownerId === ownerId) {
        this.leases.delete(runId);
      }
      return { rows: [] };
    }
    throw new Error(`Unhandled SQL in test double: ${sql}`);
  }
}

function makeRun(runId: string, status: AgentRunRecord["status"] = "ready"): AgentRunRecord {
  return {
    runId,
    status,
    maxSteps: 3,
    llmRounds: 0,
    initial: {
      model: "openai/gpt-4o-mini",
      systemPrompt: "Be concise.",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    },
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    createdAt: `2026-04-21T00:00:0${runId.endsWith("2") ? "2" : "1"}.000Z`,
    updatedAt: "2026-04-21T00:00:01.000Z",
  };
}

describe("PostgresSessionStore", () => {
  it("initializes schema and persists runs with listing support", async () => {
    const db = new MockPostgresDb();
    const store = new PostgresSessionStore({ db, schema: "agent_runtime" });

    await store.init();
    await store.createRun(makeRun("run-1"));
    await store.createRun(makeRun("run-2", "finished"));

    expect((await store.getRun("run-1"))?.runId).toBe("run-1");
    expect((await store.listRuns({ statuses: ["ready"] })).map((run) => run.runId)).toEqual(["run-1"]);
  });

  it("stores events and coordinates leases", async () => {
    const db = new MockPostgresDb();
    const store = new PostgresSessionStore({ db });

    const event: AgentRuntimeEvent = {
      type: "run_created",
      runId: "run-1",
      at: "2026-04-21T00:00:00.000Z",
      model: "openai/gpt-4o-mini",
      maxSteps: 3,
    };
    await store.appendEvents("run-1", [event]);
    expect(await store.listEvents("run-1", { offset: 0, limit: 1 })).toEqual([event]);

    const lease = await store.acquireLease("run-1", "worker-a", 10_000);
    expect(lease?.ownerId).toBe("worker-a");
    expect(await store.acquireLease("run-1", "worker-b", 10_000)).toBeNull();
    expect((await store.renewLease("run-1", "worker-a", 10_000))?.ownerId).toBe("worker-a");
    await store.releaseLease("run-1", "worker-a");
    expect(await store.getLease("run-1")).toBeNull();
  });
});
