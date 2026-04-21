import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cloneContextValue } from "../agent/clone";
import type {
  AgentEventQuery,
  AgentRunLease,
  AgentRunQuery,
  AgentRunRecord,
  AgentRuntimeEvent,
  AgentSessionStore,
} from "./session-store";

type FileSessionStoreOptions = {
  directory: string;
};

type PersistedRunEnvelope = {
  run: AgentRunRecord;
};

type PersistedEventsEnvelope = {
  events: AgentRuntimeEvent[];
};

type PersistedLeaseEnvelope = {
  lease: AgentRunLease;
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
  if (value == null) {
    return value;
  }
  if (value instanceof Error) {
    return serializeError(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toSerializableValue(entry)) as T;
  }
  if (value instanceof Date) {
    return new Date(value.getTime()).toISOString() as T;
  }
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].map(([key, entry]) => [String(key), toSerializableValue(entry)]),
    ) as T;
  }
  if (value instanceof Set) {
    return [...value].map((entry) => toSerializableValue(entry)) as T;
  }
  if (typeof value === "object" && isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = toSerializableValue(entry);
    }
    return out as T;
  }
  return cloneContextValue(value);
}

function sliceEvents(events: AgentRuntimeEvent[], query?: AgentEventQuery): AgentRuntimeEvent[] {
  const offset = Math.max(0, query?.offset ?? 0);
  const limit = query?.limit;
  const sliced = events.slice(offset, limit == null ? undefined : offset + Math.max(0, limit));
  return sliced.map((event) => cloneContextValue(event));
}

function sliceRuns(runs: AgentRunRecord[], query?: AgentRunQuery): AgentRunRecord[] {
  const statuses = query?.statuses?.length ? new Set(query.statuses) : undefined;
  const filtered = statuses ? runs.filter((run) => statuses.has(run.status)) : runs;
  const sorted = [...filtered].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const offset = Math.max(0, query?.offset ?? 0);
  const limit = query?.limit;
  return sorted
    .slice(offset, limit == null ? undefined : offset + Math.max(0, limit))
    .map((run) => cloneContextValue(run));
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    const content = await readFile(path, "utf8");
    return JSON.parse(content) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export class FileSessionStore implements AgentSessionStore {
  private readonly directory: string;
  private readonly runsDirectory: string;
  private readonly eventsDirectory: string;
  private readonly leasesDirectory: string;

  constructor(options: FileSessionStoreOptions) {
    this.directory = options.directory;
    this.runsDirectory = join(this.directory, "runs");
    this.eventsDirectory = join(this.directory, "events");
    this.leasesDirectory = join(this.directory, "leases");
  }

  async createRun(run: AgentRunRecord): Promise<void> {
    await this.saveRun(run);
    const eventPath = this.getEventsPath(run.runId);
    const envelope = await readJsonFile<PersistedEventsEnvelope>(eventPath, { events: [] });
    await atomicWriteJson(eventPath, { events: envelope.events.map((event) => toSerializableValue(event)) });
  }

  async saveRun(run: AgentRunRecord): Promise<void> {
    await atomicWriteJson(this.getRunPath(run.runId), {
      run: toSerializableValue(run),
    } satisfies PersistedRunEnvelope);
  }

  async getRun(runId: string): Promise<AgentRunRecord | null> {
    const envelope = await readJsonFile<PersistedRunEnvelope | null>(this.getRunPath(runId), null);
    return envelope?.run ? cloneContextValue(envelope.run) : null;
  }

  async listRuns(query?: AgentRunQuery): Promise<AgentRunRecord[]> {
    await mkdir(this.runsDirectory, { recursive: true });
    const files = await readdir(this.runsDirectory);
    const runs = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => {
          const envelope = await readJsonFile<PersistedRunEnvelope | null>(join(this.runsDirectory, file), null);
          return envelope?.run ?? null;
        }),
    );
    return sliceRuns(
      runs.filter((run): run is AgentRunRecord => run != null),
      query,
    );
  }

  async appendEvents(runId: string, events: AgentRuntimeEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    const path = this.getEventsPath(runId);
    const envelope = await readJsonFile<PersistedEventsEnvelope>(path, { events: [] });
    envelope.events.push(...events.map((event) => toSerializableValue(event)));
    await atomicWriteJson(path, envelope);
  }

  async listEvents(runId: string, query?: AgentEventQuery): Promise<AgentRuntimeEvent[]> {
    const envelope = await readJsonFile<PersistedEventsEnvelope>(this.getEventsPath(runId), { events: [] });
    return sliceEvents(envelope.events, query);
  }

  async getLease(runId: string): Promise<AgentRunLease | null> {
    const envelope = await readJsonFile<PersistedLeaseEnvelope | null>(this.getLeasePath(runId), null);
    if (!envelope?.lease) {
      return null;
    }
    if (Date.parse(envelope.lease.expiresAt) <= Date.now()) {
      await atomicWriteJson(this.getLeasePath(runId), null);
      return null;
    }
    return cloneContextValue(envelope.lease);
  }

  async acquireLease(runId: string, ownerId: string, ttlMs: number): Promise<AgentRunLease | null> {
    const current = await this.getLease(runId);
    if (current && current.ownerId !== ownerId) {
      return null;
    }
    const now = new Date();
    const lease: AgentRunLease = {
      runId,
      ownerId,
      acquiredAt: current?.acquiredAt ?? now.toISOString(),
      expiresAt: new Date(now.getTime() + Math.max(1, ttlMs)).toISOString(),
    };
    await atomicWriteJson(this.getLeasePath(runId), { lease: toSerializableValue(lease) } satisfies PersistedLeaseEnvelope);
    return cloneContextValue(lease);
  }

  async renewLease(runId: string, ownerId: string, ttlMs: number): Promise<AgentRunLease | null> {
    const current = await this.getLease(runId);
    if (!current || current.ownerId !== ownerId) {
      return null;
    }
    const renewed: AgentRunLease = {
      ...current,
      expiresAt: new Date(Date.now() + Math.max(1, ttlMs)).toISOString(),
    };
    await atomicWriteJson(this.getLeasePath(runId), {
      lease: toSerializableValue(renewed),
    } satisfies PersistedLeaseEnvelope);
    return cloneContextValue(renewed);
  }

  async releaseLease(runId: string, ownerId: string): Promise<void> {
    const current = await this.getLease(runId);
    if (!current || current.ownerId !== ownerId) {
      return;
    }
    await atomicWriteJson(this.getLeasePath(runId), null);
  }

  private getRunPath(runId: string): string {
    return join(this.runsDirectory, `${runId}.json`);
  }

  private getEventsPath(runId: string): string {
    return join(this.eventsDirectory, `${runId}.json`);
  }

  private getLeasePath(runId: string): string {
    return join(this.leasesDirectory, `${runId}.json`);
  }
}
