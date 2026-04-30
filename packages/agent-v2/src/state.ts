import type { Message } from "./message.js";

export type TokenUsage = {
  input: number;
  output: number;
  total?: number;
  estimated?: boolean;
};

export type RunStatus =
  | "ready"
  | "running"
  | "waiting_input"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type RunState = {
  runId: string;
  status: RunStatus;
  model: string;
  systemPrompt: string;
  messages: Message[];
  workingMemory: Record<string, unknown>;
  stepCount: number;
  tokenUsage: TokenUsage;
  startedAt: number;
  lastActiveAt: number;
  /** Worker that holds the lease (if locked), per DESIGN.md C.11 */
  lockedBy?: string;
  /** Timestamp when the lease was acquired */
  lockedAt?: number;
};

export function initState(params: {
  runId: string;
  model: string;
  systemPrompt: string;
  messages: Message[];
  workingMemory?: Record<string, unknown>;
  stepCount?: number;
  tokenUsage?: TokenUsage;
}): RunState {
  const now = Date.now();
  return {
    runId: params.runId,
    status: "running",
    model: params.model,
    systemPrompt: params.systemPrompt,
    messages: params.messages,
    workingMemory: params.workingMemory ?? {},
    stepCount: params.stepCount ?? 0,
    tokenUsage: params.tokenUsage ?? { input: 0, output: 0, total: 0 },
    startedAt: now,
    lastActiveAt: now,
  };
}
