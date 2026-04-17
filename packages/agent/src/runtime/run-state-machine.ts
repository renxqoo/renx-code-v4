import { randomUUID } from "node:crypto";
import type { Message } from "../domain/message";
import type { QueryModelType } from "../domain/query-model";
import type {
  AgentCheckpointStore,
  AgentRunSnapshot,
  AgentRunStatus,
  AgentStepSnapshot,
  AgentStepStatus,
} from "./checkpoint-store";

type CreateRunStateInput = {
  initial: QueryModelType;
  maxSteps: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

function cloneMessages(messages: Message[]): Message[] {
  return messages.map((message) => ({
    ...message,
    content: message.content.map((part) => ({ ...part })),
  }));
}

export class RunStateMachine {
  private readonly store: AgentCheckpointStore;
  private readonly snapshot: AgentRunSnapshot;

  constructor(input: CreateRunStateInput, store: AgentCheckpointStore) {
    this.store = store;
    this.snapshot = {
      runId: randomUUID(),
      status: "ready",
      maxSteps: input.maxSteps,
      currentStepIndex: 0,
      model: input.initial.model,
      messages: cloneMessages(input.initial.messages),
    };
  }

  get runId(): string {
    return this.snapshot.runId;
  }

  get status(): AgentRunStatus {
    return this.snapshot.status;
  }

  toSnapshot(): AgentRunSnapshot {
    return {
      ...this.snapshot,
      messages: cloneMessages(this.snapshot.messages),
    };
  }

  setMessages(messages: Message[]): void {
    this.snapshot.messages = cloneMessages(messages);
  }

  async persistRun(): Promise<void> {
    await this.store.saveRun(this.toSnapshot());
  }

  async start(): Promise<void> {
    this.assertStatus(["ready"]);
    this.snapshot.status = "running";
    this.snapshot.startedAt = nowIso();
    await this.persistRun();
  }

  async markWaiting(status: Extract<AgentRunStatus, "waiting_permission" | "waiting_input">): Promise<void> {
    this.assertStatus(["running"]);
    this.snapshot.status = status;
    await this.persistRun();
  }

  async resumeRunning(): Promise<void> {
    this.assertStatus(["waiting_input", "waiting_permission", "running"]);
    this.snapshot.status = "running";
    await this.persistRun();
  }

  async complete(messages: Message[], stopReason: string): Promise<void> {
    this.assertStatus(["running", "waiting_input", "waiting_permission"]);
    this.snapshot.status = "finished";
    this.snapshot.messages = cloneMessages(messages);
    this.snapshot.stopReason = stopReason;
    this.snapshot.finishedAt = nowIso();
    await this.persistRun();
  }

  async fail(messages: Message[], error: unknown, stopReason = "fatal_error"): Promise<void> {
    this.assertStatus(["running", "waiting_input", "waiting_permission"]);
    this.snapshot.status = "failed";
    this.snapshot.messages = cloneMessages(messages);
    this.snapshot.stopReason = stopReason;
    this.snapshot.lastError = error;
    this.snapshot.finishedAt = nowIso();
    await this.persistRun();
  }

  async beginStep(stepIndex: number, llmRound: number, messages: Message[]): Promise<void> {
    this.assertStatus(["running"]);
    this.snapshot.currentStepIndex = stepIndex;
    this.snapshot.messages = cloneMessages(messages);
    await this.persistRun();
    await this.persistStep({
      stepIndex,
      llmRound,
      status: "preparing",
      messages,
    });
  }

  async persistStep(partial: {
    stepIndex: number;
    llmRound: number;
    status: AgentStepStatus;
    messages: Message[];
    assistantText?: string;
    toolCalls?: AgentStepSnapshot["toolCalls"];
    finishReason?: AgentStepSnapshot["finishReason"];
    usage?: AgentStepSnapshot["usage"];
    error?: unknown;
  }): Promise<void> {
    const snapshot: AgentStepSnapshot = {
      runId: this.snapshot.runId,
      stepIndex: partial.stepIndex,
      llmRound: partial.llmRound,
      status: partial.status,
      messages: cloneMessages(partial.messages),
      assistantText: partial.assistantText,
      toolCalls: partial.toolCalls ? partial.toolCalls.map((call) => ({ ...call })) : undefined,
      finishReason: partial.finishReason,
      usage: partial.usage ? { ...partial.usage } : undefined,
      error: partial.error,
    };
    await this.store.saveStep(snapshot);
  }

  private assertStatus(allowed: AgentRunStatus[]): void {
    if (!allowed.includes(this.snapshot.status)) {
      throw new Error(
        `Invalid run state transition from ${this.snapshot.status}. Allowed: ${allowed.join(", ")}`,
      );
    }
  }
}
