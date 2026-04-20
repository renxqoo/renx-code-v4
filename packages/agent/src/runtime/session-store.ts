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

export interface AgentSessionStore {
  createRun(run: AgentRunRecord): Promise<void>;
  saveRun(run: AgentRunRecord): Promise<void>;
  getRun(runId: string): Promise<AgentRunRecord | null>;
  appendEvents(runId: string, events: AgentRuntimeEvent[]): Promise<void>;
  listEvents(runId: string): Promise<AgentRuntimeEvent[]>;
}

function cloneRunRecord(run: AgentRunRecord): AgentRunRecord {
  return cloneContextValue(run);
}

function cloneEvent(event: AgentRuntimeEvent): AgentRuntimeEvent {
  return cloneContextValue(event);
}

export class InMemorySessionStore implements AgentSessionStore {
  private readonly runs = new Map<string, AgentRunRecord>();
  private readonly events = new Map<string, AgentRuntimeEvent[]>();

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

  async appendEvents(runId: string, events: AgentRuntimeEvent[]): Promise<void> {
    const current = this.events.get(runId) ?? [];
    current.push(...events.map((event) => cloneEvent(event)));
    this.events.set(runId, current);
  }

  async listEvents(runId: string): Promise<AgentRuntimeEvent[]> {
    return (this.events.get(runId) ?? []).map((event) => cloneEvent(event));
  }
}
