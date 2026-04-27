import type { Message } from "./message.js";
import type { TokenUsage, RunState } from "./state.js";
import type { AgentError } from "./errors.js";
import type { ToolCallInfo } from "./tool.js";

// Re-export TokenUsage from llm-client for convenience
export type { TokenUsage } from "./state.js";

export type JsonSchema = Record<string, unknown>;

export type CanonicalToolSchema = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

export type LLMStreamRequest = {
  model: string;
  systemPrompt: string;
  messages: Message[];
  tools?: CanonicalToolSchema[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
};

export type LLMTextDeltaChunk = {
  type: "text-delta";
  delta: string;
};

export type LLMToolCallDeltaChunk = {
  type: "tool-call-delta";
  id: string;
  name: string;
  argsDelta: string;
};

export type LLMFinishChunk = {
  type: "finish";
  finishReason: string;
  usage: TokenUsage;
};

export type LLMErrorChunk = {
  type: "error";
  error: AgentError;
};

export type LLMChunk =
  | LLMTextDeltaChunk
  | LLMToolCallDeltaChunk
  | LLMFinishChunk
  | LLMErrorChunk;

export type LLMStreamGenerator = AsyncGenerator<LLMChunk, void, void>;

export type LLMClient = {
  stream: (request: LLMStreamRequest) => LLMStreamGenerator;
};

let _defaultClient: LLMClient | undefined;

export function setDefaultLLMClient(client: LLMClient): void {
  _defaultClient = client;
}

export function getDefaultLLMClient(): LLMClient {
  if (!_defaultClient) {
    throw new Error(
      "No LLMClient configured. Call setDefaultLLMClient() or pass llmClient in AgentInput.",
    );
  }
  return _defaultClient;
}

export type InternalRunContext = {
  resumeApprovals?: { callId: string; action: "allow" | "deny" }[];
};

export type OnToolsContext = {
  toolCalls: ToolCallInfo[];
  state: RunState;
  priorApprovals?: { callId: string; action: "allow" | "deny" }[];
};

export type OnToolsDecision =
  | { action: "execute" }
  | { action: "deny"; callIds: string[]; reason: string }
  | { action: "abort"; reason: string }
  | { action: "pause"; callIds: string[]; reason: string };
