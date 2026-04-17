import type { QueryModelType } from "../domain/query-model";
import { createDefaultLLMClient, type LLMClient } from "@renx/provider";
import { createDefaultSandboxRegistry } from "../sandbox/default-registry";
import type { SandboxRegistry } from "../sandbox/sandbox-registry";
import { ToolRegistry } from "../tools/registry";
import { AgentRuntime } from "../runtime/agent-runtime";
import type { AgentHook } from "./hooks";
import { noopLogger, type AgentLogger } from "./logger";
import type {
  AgentConstructorConfig,
  QueryModelHooks,
  QueryModelOutcome,
} from "./types";

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
export type {
  AgentCheckpointStore,
  AgentRunSnapshot,
  AgentRunStatus,
  AgentStepSnapshot,
  AgentStepStatus,
} from "../runtime/checkpoint-store";
export { noopCheckpointStore } from "../runtime/checkpoint-store";
export type { TerminationEvaluation, TerminationPolicy } from "../runtime/termination-policy";
export { DefaultTerminationPolicy } from "../runtime/termination-policy";
export { AgentRuntime } from "../runtime/agent-runtime";
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
    "maxSteps" | "llmRetry" | "checkpointStore" | "terminationPolicy"
  >;
  private readonly llmClient: LLMClient | undefined;
  private readonly registry: ToolRegistry;
  private readonly sandboxRegistry: SandboxRegistry;
  private readonly hooks: AgentHook[] = [];
  private readonly logger: AgentLogger;

  constructor(config: AgentConstructorConfig) {
    this.config = {
      maxSteps: config.maxSteps,
      llmRetry: config.llmRetry,
      checkpointStore: config.checkpointStore,
      terminationPolicy: config.terminationPolicy,
    };
    this.llmClient =
      config.llmClientOptions != null ? createDefaultLLMClient(config.llmClientOptions) : undefined;
    this.registry = config.registry ?? new ToolRegistry();
    this.sandboxRegistry = config.sandboxRegistry ?? createDefaultSandboxRegistry();
    this.logger = config.logger ?? noopLogger;
  }

  /**
   * Register enterprise hooks for permissions, audits, logging, and experiment switches.
   */
  use(...hooks: AgentHook[]): this {
    for (const hook of hooks) {
      this.hooks.push(hook);
    }
    return this;
  }

  getToolRegistry(): ToolRegistry {
    return this.registry;
  }

  /** 当前 Agent 使用的沙箱注册表（可预先 `register` 自定义 profile）。 */
  getSandboxRegistry(): SandboxRegistry {
    return this.sandboxRegistry;
  }

  async queryModel(initial: QueryModelType, hooks?: QueryModelHooks): Promise<QueryModelOutcome> {
    const runtime = new AgentRuntime({
      maxSteps: this.config.maxSteps,
      registry: this.registry,
      sandboxRegistry: this.sandboxRegistry,
      hooks: this.hooks,
      llmRetry: this.config.llmRetry,
      llmClient: this.llmClient,
      logger: this.logger,
      checkpointStore: this.config.checkpointStore,
      terminationPolicy: this.config.terminationPolicy,
    });
    return runtime.run(initial, hooks);
  }
}
