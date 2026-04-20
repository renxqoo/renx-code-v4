import type { QueryModelType } from "../domain/query-model";
import { createDefaultLLMClient, type LLMClient } from "@renx/provider";
import { createDefaultSandboxRegistry } from "../sandbox/default-registry";
import type { SandboxRegistry } from "../sandbox/sandbox-registry";
import { ToolRegistry } from "../tools/registry";
import { DefaultContextBuilder, type ContextBuilder } from "../runtime/context-builder";
import { AgentRuntime, type ResumeRunInput } from "../runtime/agent-runtime";
import { InMemorySessionStore, type AgentRunRecord, type AgentRuntimeEvent, type AgentSessionStore } from "../runtime/session-store";
import { DefaultSummaryManager, type SummaryManager } from "../runtime/summary-manager";
import type { AgentHook } from "./hooks";
import { noopLogger, type AgentLogger } from "./logger";
import type { AgentConstructorConfig, QueryModelHooks, QueryModelOutcome } from "./types";

export type {
  AgentConstructorConfig,
  AgentModelResponseSnapshot,
  LlmRetryConfig,
  LlmRetryPredicateContext,
  QueryModelHooks,
  QueryModelOutcome,
  QueryStreamChunkMeta,
} from "./types";
export type { CreateDefaultLLMClientOptions } from "@renx/provider";
export type { SandboxRegistry } from "../sandbox/sandbox-registry";
export { createDefaultSandboxRegistry, buildSandboxExecutionContext } from "../sandbox/index";
export { ToolRegistry } from "../tools/registry";
export type { TerminationEvaluation, TerminationPolicy } from "../runtime/termination-policy";
export { DefaultTerminationPolicy } from "../runtime/termination-policy";
export { AgentRuntime } from "../runtime/agent-runtime";
export type { ResumeRunInput } from "../runtime/agent-runtime";
export type {
  AgentPendingApproval,
  AgentPendingInput,
  AgentRunRecord,
  AgentRunStatus,
  AgentRunSummary,
  AgentRuntimeEvent,
  AgentSessionStore,
} from "../runtime/session-store";
export { InMemorySessionStore } from "../runtime/session-store";
export type { ContextBuilder } from "../runtime/context-builder";
export { DefaultContextBuilder } from "../runtime/context-builder";
export type { SummaryManager } from "../runtime/summary-manager";
export { DefaultSummaryManager } from "../runtime/summary-manager";
export type {
  AgentFeatureFlagValue,
  AgentHook,
  AgentHookEvent,
  AgentRunProfilePatch,
  AgentToolAuthorizationContext,
  AgentToolAuthorizationResult,
  AgentToolInvocation,
  PermissionHookOptions,
  ResolvedRunProfile,
} from "./hooks";
export {
  createAuditHook,
  createDefaultRunProfile,
  createExperimentHook,
  createLoggingHook,
  createPermissionHook,
  mergeRunProfile,
} from "./hooks";
export {
  createStreamRecorder,
  type CreateStreamRecorderOptions,
  type StreamRecorder,
} from "./stream-recorder";
export { RuntimeError } from "../model/runtime";
export {
  computeRetryDelayMs,
  DEFAULT_LLM_MAX_RETRIES,
  sleepRetryDelay,
} from "./llm-retry";
export { noopLogger, consoleLogger, type AgentLogger } from "./logger";

export class Agent {
  protected readonly config: Pick<
    AgentConstructorConfig,
    "maxSteps" | "llmRetry" | "terminationPolicy"
  >;
  private readonly llmClient: LLMClient | undefined;
  private readonly registry: ToolRegistry;
  private readonly sandboxRegistry: SandboxRegistry;
  private readonly hooks: AgentHook[] = [];
  private readonly logger: AgentLogger;
  private readonly sessionStore: AgentSessionStore;
  private readonly contextBuilder: ContextBuilder;
  private readonly summaryManager: SummaryManager;

  constructor(config: AgentConstructorConfig) {
    this.config = {
      maxSteps: config.maxSteps,
      llmRetry: config.llmRetry,
      terminationPolicy: config.terminationPolicy,
    };
    this.llmClient =
      config.llmClientOptions != null ? createDefaultLLMClient(config.llmClientOptions) : undefined;
    this.registry = config.registry ?? new ToolRegistry();
    this.sandboxRegistry = config.sandboxRegistry ?? createDefaultSandboxRegistry();
    this.logger = config.logger ?? noopLogger;
    this.sessionStore = config.sessionStore ?? new InMemorySessionStore();
    this.contextBuilder = config.contextBuilder ?? new DefaultContextBuilder();
    this.summaryManager = config.summaryManager ?? new DefaultSummaryManager();
  }

  use(...hooks: AgentHook[]): this {
    for (const hook of hooks) {
      this.hooks.push(hook);
    }
    return this;
  }

  getToolRegistry(): ToolRegistry {
    return this.registry;
  }

  getSandboxRegistry(): SandboxRegistry {
    return this.sandboxRegistry;
  }

  getSessionStore(): AgentSessionStore {
    return this.sessionStore;
  }

  async createRun(initial: QueryModelType): Promise<AgentRunRecord> {
    return this.runtime().createRun(initial);
  }

  async startRun(runId: string, hooks?: QueryModelHooks): Promise<QueryModelOutcome> {
    return this.runtime().startRun(runId, hooks);
  }

  async resumeRun(runId: string, input?: ResumeRunInput, hooks?: QueryModelHooks): Promise<QueryModelOutcome> {
    return this.runtime().resumeRun(runId, input, hooks);
  }

  async cancelRun(runId: string): Promise<AgentRunRecord> {
    return this.runtime().cancelRun(runId);
  }

  async getRun(runId: string): Promise<AgentRunRecord | null> {
    return this.runtime().getRun(runId);
  }

  async getRunTrace(runId: string): Promise<AgentRuntimeEvent[]> {
    return this.runtime().getRunTrace(runId);
  }

  async run(initial: QueryModelType, hooks?: QueryModelHooks): Promise<QueryModelOutcome> {
    return this.runtime().run(initial, hooks);
  }

  private runtime(): AgentRuntime {
    return new AgentRuntime({
      maxSteps: this.config.maxSteps,
      registry: this.registry,
      sandboxRegistry: this.sandboxRegistry,
      hooks: this.hooks,
      llmRetry: this.config.llmRetry,
      llmClient: this.llmClient,
      logger: this.logger,
      sessionStore: this.sessionStore,
      terminationPolicy: this.config.terminationPolicy,
      contextBuilder: this.contextBuilder,
      summaryManager: this.summaryManager,
    });
  }
}
