import type { CanonicalFinishReason, CanonicalToolCall, CanonicalUsage } from "@renx/provider";
import type { Message } from "../domain/message";

export type AgentRunStatus =
  | "ready"
  | "running"
  | "waiting_permission"
  | "waiting_input"
  | "finished"
  | "failed";

export type AgentStepStatus =
  | "preparing"
  | "building_context"
  | "calling_model"
  | "dispatching_decision"
  | "executing_tools"
  | "evaluating_termination"
  | "completed"
  | "failed";

export type AgentRunSnapshot = {
  runId: string;
  status: AgentRunStatus;
  maxSteps: number;
  currentStepIndex: number;
  model: unknown;
  messages: Message[];
  startedAt?: string;
  finishedAt?: string;
  stopReason?: string;
  lastError?: unknown;
};

export type AgentStepSnapshot = {
  runId: string;
  stepIndex: number;
  status: AgentStepStatus;
  llmRound: number;
  messages: Message[];
  assistantText?: string;
  toolCalls?: CanonicalToolCall[];
  finishReason?: CanonicalFinishReason;
  usage?: CanonicalUsage;
  error?: unknown;
};

export interface AgentCheckpointStore {
  saveRun(snapshot: AgentRunSnapshot): Promise<void> | void;
  saveStep(snapshot: AgentStepSnapshot): Promise<void> | void;
}

export const noopCheckpointStore: AgentCheckpointStore = {
  saveRun() {},
  saveStep() {},
};
