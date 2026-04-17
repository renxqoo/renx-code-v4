import type { QueryModelType } from "../domain/query-model";
import { createDefaultLLMClient, type LLMClient } from "@renx/provider";
import { createDefaultSandboxRegistry } from "../sandbox/default-registry";
import type { SandboxRegistry } from "../sandbox/sandbox-registry";
import { ToolRegistry } from "../tools/registry";
import { runQueryModelLoop } from "./query-model-loop";
import type { AgentMiddleware } from "./middleware";
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
export {
  createStreamRecorder,
  type CreateStreamRecorderOptions,
  type StreamRecorder,
} from "./stream-recorder";
export type {
  AgentEventName,
  AgentMiddleware,
  AgentMiddlewareContext,
  HookControlPatch,
  HookPatchBucket,
  MiddlewareCarry,
  Next,
  TypedAgentMiddleware,
  TypedAgentMiddlewareContext,
  TypedMiddlewareCarry,
} from "./middleware";
export { AGENT_EVENTS } from "./middleware";
export { RuntimeError } from "../model/runtime";
export {
  createPermissionConfirmMiddleware,
  createStoreMessagesMiddleware,
  type PermissionConfirmOptions,
  type PermissionConfirmRequest,
  type PermissionToolInvocation,
  type StoreMessagesMeta,
  type StoreMessagesOptions,
  type StoreMessagesPayload,
} from "./middlewares";
export {
  computeRetryDelayMs,
  DEFAULT_LLM_MAX_RETRIES,
  LLM_RETRY_REMAINING_KEY,
  sleepRetryDelay,
} from "./llm-retry";
export { noopLogger, consoleLogger, type AgentLogger } from "./logger";

export class Agent {
  protected readonly config: Pick<AgentConstructorConfig, "maxSteps" | "llmRetry">;
  private readonly llmClient: LLMClient | undefined;
  private readonly registry: ToolRegistry;
  private readonly sandboxRegistry: SandboxRegistry;
  private readonly middlewares: AgentMiddleware[] = [];
  private readonly logger: AgentLogger;

  constructor(config: AgentConstructorConfig) {
    this.config = { maxSteps: config.maxSteps, llmRetry: config.llmRetry };
    this.llmClient =
      config.llmClientOptions != null ? createDefaultLLMClient(config.llmClientOptions) : undefined;
    this.registry = config.registry ?? new ToolRegistry();
    this.sandboxRegistry = config.sandboxRegistry ?? createDefaultSandboxRegistry();
    this.logger = config.logger ?? noopLogger;
  }

  /**
   * Koa 风格：按注册顺序组成洋葱模型。
   * 通过 `ctx.event` 区分阶段（与 `AGENT_EVENTS` 一致）。
   */
  use(...fns: AgentMiddleware[]): this {
    for (const fn of fns) {
      this.middlewares.push(fn);
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
    try {
      return await runQueryModelLoop({
        initial,
        maxSteps: this.config.maxSteps,
        registry: this.registry,
        hooks,
        middlewares: this.middlewares,
        sandboxRegistry: this.sandboxRegistry,
        llmRetry: this.config.llmRetry,
        llmClient: this.llmClient,
        logger: this.logger,
      });
    } catch (err) {
      return {
        messages: [...initial.messages],
        finishReason: "error",
        llmRounds: 0,
        lastStream: {
          ok: false,
          error: err,
          textStream: (async function* () {})(),
          text: Promise.resolve(""),
          reasoning: Promise.resolve(""),
          toolCalls: Promise.resolve([]),
          usage: Promise.resolve(undefined),
          finishReason: Promise.resolve("error"),
        },
        error: err,
      };
    }
  }
}
