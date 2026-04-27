import type { TokenUsage } from "./state.js";
import type { AgentError } from "./errors.js";
import type { Message } from "./message.js";

/** Outcome embedded in run:finished event (structurally compatible with AgentResult). */
type RunOutcome = {
  runId: string;
  messages: Message[];
  text: string;
  workingMemory: Record<string, unknown>;
  tokenUsage: TokenUsage;
  finishReason: "stop" | "error" | "max_steps" | "handoff" | "cancelled";
  totalSteps: number;
  error?: AgentError;
  handoff?: {
    targetAgent: string;
    reason: string;
  };
};

export type RunStartedEvent = {
  type: "run:started";
  runId: string;
  model: string;
  systemPrompt: string;
  tools?: string[];
  maxSteps: number;
};

export type StepStartedEvent = {
  type: "step:started";
  step: number;
};

export type StepCompletedEvent = {
  type: "step:completed";
  step: number;
  finishReason: string;
  tokenUsage: TokenUsage;
};

export type RunFinishedEvent = {
  type: "run:finished";
  outcome: RunOutcome;
};

export type LLMDeltaEvent = {
  type: "llm:delta";
  step: number;
  delta: string;
};

export type LLMToolCallEvent = {
  type: "llm:tool-call";
  step: number;
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type LLMDoneEvent = {
  type: "llm:done";
  step: number;
  finishReason: string;
  usage: TokenUsage;
  text: string | null;
  error?: AgentError;
};

export type ToolStartEvent = {
  type: "tool:start";
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ToolResultEvent = {
  type: "tool:result";
  callId: string;
  ok: boolean;
  output: unknown;
  durationMs: number;
};

export type ToolErrorEvent = {
  type: "tool:error";
  callId: string;
  error: string;
};

export type PauseInputEvent = {
  type: "pause:input";
  reason: string;
  runId: string;
};

export type PauseApprovalEvent = {
  type: "pause:approval";
  runId: string;
  callIds: string[];
  tools: string[];
  arguments: Record<string, unknown>[];
};

export type CancelledEvent = {
  type: "run:cancelled";
  runId: string;
  step: number;
};

export type HandoffEvent = {
  type: "handoff";
  from: string;
  to: string;
  reason: string;
};

export type AgentEvent =
  | RunStartedEvent
  | StepStartedEvent
  | StepCompletedEvent
  | RunFinishedEvent
  | LLMDeltaEvent
  | LLMToolCallEvent
  | LLMDoneEvent
  | ToolStartEvent
  | ToolResultEvent
  | ToolErrorEvent
  | PauseInputEvent
  | PauseApprovalEvent
  | CancelledEvent
  | HandoffEvent;
