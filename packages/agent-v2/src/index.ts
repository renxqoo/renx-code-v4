// Agent function
export { agent } from "./agent.js";

export const PACKAGE_NAME = "@renx/agent-v2" as const;

// Plugin
export { pipe } from "./plugin.js";
export type { Plugin, AgentFn } from "./plugin.js";

// Events
export type {
  AgentEvent,
  RunStartedEvent,
  StepStartedEvent,
  StepCompletedEvent,
  RunFinishedEvent,
  LLMDeltaEvent,
  LLMToolCallEvent,
  LLMDoneEvent,
  ToolStartEvent,
  ToolResultEvent,
  ToolErrorEvent,
  PauseInputEvent,
  PauseApprovalEvent,
  CancelledEvent,
  HandoffEvent,
} from "./events.js";

// Types
export type {
  AgentInput,
  AgentResult,
  AgentGenerator,
  HandoffInfo,
  OnToolsContext,
  OnToolsDecision,
  InternalRunContext,
} from "./types.js";

// Messages
export type {
  Message,
  SystemMessage,
  UserMessage,
  AssistantMessage,
  ToolMessage,
  ContentBlock,
  ToolCall,
} from "./message.js";
export {
  systemMessage,
  userMessage,
  assistantMessage,
  toolMessage,
} from "./message.js";

// Tool
export type { Tool, ToolContext, ToolCallInfo } from "./tool.js";

// State
export type { RunState, RunStatus, TokenUsage } from "./state.js";
export { initState } from "./state.js";

// LLM Client
export type {
  LLMClient,
  LLMChunk,
  LLMStreamRequest,
  LLMStreamGenerator,
  LLMTextDeltaChunk,
  LLMToolCallDeltaChunk,
  LLMFinishChunk,
  LLMErrorChunk,
  CanonicalToolSchema,
  JsonSchema,
} from "./llm-client.js";
export { setDefaultLLMClient, getDefaultLLMClient } from "./llm-client.js";

// Errors
export type { AgentError, AgentErrorCode } from "./errors.js";
export { createAgentError } from "./errors.js";

// Handoff
export { HandoffSignal } from "./handoff-signal.js";

// Utils
export { generateId } from "./utils/id.js";
export { renxDataDir, renxSessionsDir } from "./utils/paths.js";

// Memory
export type {
  MemoryStore,
  Memory,
  MemorySearchResult,
  MemoryType,
  Entity,
  Relation,
  Profile,
  ProfileKey,
  EmbeddingClient,
  MemoryLogger,
} from "./memory/store.js";
export { InMemoryMemoryStore, type InMemoryStoreConfig } from "./memory/in-memory-store.js";
export {
  createPgVectorMemoryStore,
  type PgPool,
  type PgVectorStoreConfig,
} from "./memory/pgvector-store.js";
export {
  retrieveMemoriesAndSkills,
  formatMemoriesAsMD,
  formatSkillsAsMD,
  formatUserProfileAsMD,
  trimToTokenBudget,
  type RetrievalResult,
  type RetrievalOptions,
  type RerankResult,
  type RerankOptions,
  type FormattedMemory,
} from "./memory/retrieval.js";
export {
  runMemoryExtraction,
  type ExtractionConfig,
} from "./memory/etl.js";
export {
  cleanupMemories,
  mergeSimilarMemories,
  detectConflicts,
  type CleanupOptions,
  type MergeOptions,
  type ConflictResult,
} from "./memory/governance.js";
