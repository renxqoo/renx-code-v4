import type { AgentEvent } from "./events.js";
import type { AgentError } from "./errors.js";
import type { LLMClient, InternalRunContext, OnToolsDecision, OnToolsContext } from "./llm-client.js";
import type { Message } from "./message.js";
import type { TokenUsage } from "./state.js";
import type { Tool } from "./tool.js";

export type HandoffInfo = {
  targetAgent: string;
  reason: string;
};

export type AgentResult = {
  runId: string;
  messages: Message[];
  text: string;
  workingMemory: Record<string, unknown>;
  tokenUsage: TokenUsage;
  finishReason: "stop" | "error" | "max_steps" | "handoff" | "cancelled";
  totalSteps: number;
  error?: AgentError;
  handoff?: HandoffInfo;
};

export type AgentGenerator = AsyncGenerator<AgentEvent, void, void>;

export type AgentFn = (input: AgentInput) => AgentGenerator;

export type AgentInput = {
  runId?: string;
  model: string;
  systemPrompt: string;
  messages: Message[];
  tools?: Tool[];
  maxSteps?: number;
  llmClient?: LLMClient;
  workingMemory?: Record<string, unknown>;
  signal?: AbortSignal;
  toolExecution?: "parallel" | "sequential";
  onTools?: (ctx: OnToolsContext) => OnToolsDecision | Promise<OnToolsDecision>;
  _internal?: InternalRunContext;
};

export type {
  OnToolsContext,
  OnToolsDecision,
  InternalRunContext,
  LLMClient,
} from "./llm-client.js";
