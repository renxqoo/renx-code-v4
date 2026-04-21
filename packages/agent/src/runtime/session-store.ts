import type { CanonicalFinishReason, CanonicalToolCall, CanonicalUsage } from "@renx/provider";
import type { AgentToolInvocation } from "../agent/hooks";
import { cloneContextValue } from "../agent/clone";
import type { Message } from "../domain/message";
import type { QueryModelType } from "../domain/query-model";

export type AgentRunStatus =
  | "ready"
  | "running"
  | "waiting_permission"
  | "waiting_input"
  | "finished"
  | "failed"
  | "cancelled";

export type AgentRunSummary = {
  summaryId: string;
  goal: string;
  completedSteps: string[];
  knownFacts: string[];
  blockers: string[];
  constraints: string[];
  updatedAt: string;
};

export type AgentPendingApproval = {
  invocations: AgentToolInvocation[];
  reason?: string;
  requestedAt: string;
};

export type AgentPendingInput = {
  reason: string;
  requestedAt: string;
};

export type AgentRuntimeEvent =
  | {
      type: "run_created";
      runId: string;
      at: string;
      model: QueryModelType["model"];
      maxSteps: number;
    }
  | {
      type: "run_started";
      runId: string;
      at: string;
      resumed: boolean;
      status: AgentRunStatus;
    }
  | {
      type: "step_started";
      runId: string;
      at: string;
      stepIndex: number;
      llmRound: number;
      messageCount: number;
    }
  | {
      type: "model_completed";
      runId: string;
      at: string;
      stepIndex: number;
      llmRound: number;
      ok: boolean;
      finishReason: CanonicalFinishReason;
      assistantText: string;
      toolCalls: CanonicalToolCall[];
      usage?: CanonicalUsage;
      error?: unknown;
    }
  | {
      type: "tool_execution_completed";
      runId: string;
      at: string;
      stepIndex: number;
      llmRound: number;
      toolCalls: CanonicalToolCall[];
      results: Array<{
        success: boolean;
        content: string;
        metadata: Record<string, unknown>;
      }>;
    }
  | {
      type: "summary_updated";
      runId: string;
      at: string;
      summary: AgentRunSummary;
    }
  | {
      type: "run_waiting";
      runId: string;
      at: string;
      status: "waiting_permission" | "waiting_input";
      reason?: string;
      pendingApproval?: AgentPendingApproval;
      pendingInput?: AgentPendingInput;
    }
  | {
      type: "user_input_appended";
      runId: string;
      at: string;
      messageCount: number;
    }
  | {
      type: "run_finished";
      runId: string;
      at: string;
      status: "finished" | "failed" | "cancelled";
      finishReason: CanonicalFinishReason;
      stopReason?: string;
      error?: unknown;
    };

export type AgentRunRecord = {
  runId: string;
  status: AgentRunStatus;
  maxSteps: number;
  llmRounds: number;
  initial: QueryModelType;
  messages: Message[];
  summary?: AgentRunSummary;
  pendingApproval?: AgentPendingApproval;
  pendingInput?: AgentPendingInput;
  stopReason?: string;
  lastError?: unknown;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
};

export type AgentEventQuery = {
  offset?: number;
  limit?: number;
};

export type AgentRunQuery = {
  statuses?: AgentRunStatus[];
  offset?: number;
  limit?: number;
};

export type AgentRunLease = {
  runId: string;
  ownerId: string;
  acquiredAt: string;
  expiresAt: string;
};

function sliceRuns(runs: AgentRunRecord[], query?: AgentRunQuery): AgentRunRecord[] {
  const statuses = query?.statuses?.length ? new Set(query.statuses) : undefined;
  const filtered = statuses ? runs.filter((run) => statuses.has(run.status)) : runs;
  const sorted = [...filtered].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const offset = Math.max(0, query?.offset ?? 0);
  const limit = query?.limit;
  return sorted
    .slice(offset, limit == null ? undefined : offset + Math.max(0, limit))
    .map((run) => cloneRunRecord(run));
}

export interface AgentSessionStore {
  createRun(run: AgentRunRecord): Promise<void>;
  saveRun(run: AgentRunRecord): Promise<void>;
  getRun(runId: string): Promise<AgentRunRecord | null>;
  listRuns(query?: AgentRunQuery): Promise<AgentRunRecord[]>;
  appendEvents(runId: string, events: AgentRuntimeEvent[]): Promise<void>;
  listEvents(runId: string, query?: AgentEventQuery): Promise<AgentRuntimeEvent[]>;
  getLease(runId: string): Promise<AgentRunLease | null>;
  acquireLease(runId: string, ownerId: string, ttlMs: number): Promise<AgentRunLease | null>;
  renewLease(runId: string, ownerId: string, ttlMs: number): Promise<AgentRunLease | null>;
  releaseLease(runId: string, ownerId: string): Promise<void>;
}

function cloneRunRecord(run: AgentRunRecord): AgentRunRecord {
  return cloneContextValue(run);
}

function cloneEvent(event: AgentRuntimeEvent): AgentRuntimeEvent {
  return cloneContextValue(event);
}

function sliceEvents(events: AgentRuntimeEvent[], query?: AgentEventQuery): AgentRuntimeEvent[] {
  const offset = Math.max(0, query?.offset ?? 0);
  const limit = query?.limit;
  const sliced = events.slice(offset, limit == null ? undefined : offset + Math.max(0, limit));
  return sliced.map((event) => cloneEvent(event));
}

export class InMemorySessionStore implements AgentSessionStore {
  private readonly runs = new Map<string, AgentRunRecord>();
  private readonly events = new Map<string, AgentRuntimeEvent[]>();
  private readonly leases = new Map<string, AgentRunLease>();

  async createRun(run: AgentRunRecord): Promise<void> {
    this.runs.set(run.runId, cloneRunRecord(run));
    if (!this.events.has(run.runId)) {
      this.events.set(run.runId, []);
    }
  }

  async saveRun(run: AgentRunRecord): Promise<void> {
    this.runs.set(run.runId, cloneRunRecord(run));
    if (!this.events.has(run.runId)) {
      this.events.set(run.runId, []);
    }
  }

  async getRun(runId: string): Promise<AgentRunRecord | null> {
    const run = this.runs.get(runId);
    return run ? cloneRunRecord(run) : null;
  }

  async listRuns(query?: AgentRunQuery): Promise<AgentRunRecord[]> {
    return sliceRuns([...this.runs.values()], query);
  }

  async appendEvents(runId: string, events: AgentRuntimeEvent[]): Promise<void> {
    const current = this.events.get(runId) ?? [];
    current.push(...events.map((event) => cloneEvent(event)));
    this.events.set(runId, current);
  }

  async listEvents(runId: string, query?: AgentEventQuery): Promise<AgentRuntimeEvent[]> {
    return sliceEvents(this.events.get(runId) ?? [], query);
  }

  async getLease(runId: string): Promise<AgentRunLease | null> {
    const lease = this.leases.get(runId);
    if (!lease) return null;
    if (Date.parse(lease.expiresAt) <= Date.now()) {
      this.leases.delete(runId);
      return null;
    }
    return cloneContextValue(lease);
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
    this.leases.set(runId, lease);
    return cloneContextValue(lease);
  }

  async renewLease(runId: string, ownerId: string, ttlMs: number): Promise<AgentRunLease | null> {
    const current = await this.getLease(runId);
    if (!current || current.ownerId !== ownerId) {
      return null;
    }
    const now = new Date();
    const renewed: AgentRunLease = {
      ...current,
      expiresAt: new Date(now.getTime() + Math.max(1, ttlMs)).toISOString(),
    };
    this.leases.set(runId, renewed);
    return cloneContextValue(renewed);
  }

  async releaseLease(runId: string, ownerId: string): Promise<void> {
    const current = await this.getLease(runId);
    if (!current || current.ownerId !== ownerId) {
      return;
    }
    this.leases.delete(runId);
  }
}
