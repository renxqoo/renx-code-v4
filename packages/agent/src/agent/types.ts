import type {
  CanonicalFinishReason,
  CanonicalStreamChunk,
  CanonicalToolCall,
  CanonicalUsage,
  CreateDefaultLLMClientOptions,
} from "@renx/provider";
import type { Message } from "../domain/message";
import type { QueryModelType } from "../domain/query-model";
import type { RuntimeOutcome } from "../model/runtime";
import type { SandboxRegistry } from "../sandbox/sandbox-registry";
import type { ToolRegistry } from "../tools/registry";
import type { AgentLogger } from "./logger";

/** 供 `llmRetry.isRetryable` 判断本次失败是否值得再发起一次 `runtime`。 */
export type LlmRetryPredicateContext = {
  error: unknown;
  /** 当前请求里的 model 字段（与 `QueryModelType.model` 一致：可能是 `minimax/...` 或带 `modelId` 的 handle）。 */
  model: QueryModelType["model"];
};

export type LlmRetryConfig = {
  maxRetries: number;
  /**
   * 若提供：仅当返回 `true` 时消耗一次剩余重试并再次请求；返回 `false` 时立即结束本轮（**不**消耗剩余次数）。
   * 若省略：与历史行为一致，凡 `ok: false` 均按剩余次数重试。
   */
  isRetryable?: (ctx: LlmRetryPredicateContext) => boolean;
  /**
   * 每次重试发起**前**等待的毫秒数（≥0）。默认 0（不等待）。
   * 可与 `retryBackoffMultiplier` 组合为指数退避；`hooks.signal` 取消时会中断等待。
   */
  retryDelayMs?: number;
  /**
   * 对等待时间的乘数：第 1 次重试前等待 `retryDelayMs * multiplier^0`，第 2 次重试前为 `retryDelayMs * multiplier^1`，以此类推。默认 1（固定间隔）。
   */
  retryBackoffMultiplier?: number;
  /**
   * 单次等待时间上限（毫秒）；与指数退避联用时对每次计算结果封顶。
   */
  retryMaxDelayMs?: number;
};

export type AgentConstructorConfig = {
  maxSteps: number;
  registry?: ToolRegistry;
  /**
   * 工具执行沙箱；默认进程内 `InProcessSandboxBackend`。
   * 注册其它 profile 后，可在中间件里写 `ctx.shared.sandboxProfile = "your_profile"`，或在 `AgentTool` 上设 `sandboxProfileId`。
   */
  sandboxRegistry?: SandboxRegistry;
  /**
   * 单次 LLM 调用（`runtime` / `streamText`）失败后的重试策略；与「换模型」无关。
   * 省略时使用 `DEFAULT_LLM_MAX_RETRIES`（Provider 默认不重试，由 Agent 承担有限重试）。
   */
  llmRetry?: LlmRetryConfig;
  /**
   * 传给 `createDefaultLLMClient`：为该 Agent 单独建 `LLMClient`（网关、密钥、厂商列表等），
   * 不依赖 `@renx/provider` 函数式 API 的模块级单例。省略时 `runtime` 仍用 `streamText(config)` 默认单例。
   */
  llmClientOptions?: CreateDefaultLLMClientOptions;
  /** Structured logger for Agent lifecycle events. Defaults to `noopLogger`. */
  logger?: AgentLogger;
};

export type QueryModelOutcome = {
  messages: Message[];
  finishReason: CanonicalFinishReason;
  llmRounds: number;
  lastStream: RuntimeOutcome;
  error?: unknown;
  /** 中间件将 `control.continue` 置为 false 时提前结束。 */
  stopped?: boolean;
  stopReason?: string;
};

/**
 * `afterModelCall` 时 `ctx.modelResponse` 的约定形状（便于中间件做 token 审计与计费）。
 */
export type AgentModelResponseSnapshot = {
  ok: boolean;
  finishReason: CanonicalFinishReason;
  assistantText: string;
  toolCalls: CanonicalToolCall[];
  usage?: CanonicalUsage;
  /** 本轮 LLM 调用序号（从 1 递增）。 */
  llmRound: number;
};

/** 每个 stream chunk 回调时的元信息（不走中间件洋葱，见 `createStreamRecorder`）。 */
export type QueryStreamChunkMeta = {
  /** 当前为第几轮 LLM（与 `QueryModelOutcome.llmRounds` 在该轮回调时一致）。 */
  llmRound: number;
  /**
   * 为 true 时表示本轮 `beforeModelCall` 中设置了 `suppressOutput`，
   * 若仍需审计/落库，可在回调里照常处理 chunk；仅在需要「不打印」时可尊重此标志。
   */
  suppressOutput: boolean;
};

export type QueryModelHooks = {
  /**
   * 每轮 LLM 的 `textStream` 每来一个 chunk 触发一次（与中间件并行存在，不经过 `compose`）。
   * 第二参从第二次参数起可选，便于兼容旧写法 `(chunk) => {}`。
   */
  onStreamChunk?: (
    chunk: CanonicalStreamChunk,
    meta: QueryStreamChunkMeta,
  ) => void | Promise<void>;
  /** 传给中间件 `ctx.signal` 与流式排空，便于取消。 */
  signal?: AbortSignal;
};
