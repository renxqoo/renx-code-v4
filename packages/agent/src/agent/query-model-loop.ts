import type { Message } from "../domain/message";
import type { QueryModelType } from "../domain/query-model";
import { cloneContextValue } from "./clone";
import {
  compose,
  mergeCarry,
  type AgentEventName,
  type AgentMiddleware,
  type AgentMiddlewareContext,
  type HookPatchBucket,
  type MiddlewareCarry,
} from "./middleware";
import { runtime, type RuntimeOutcome } from "../model/runtime";
import { drainTextStream } from "../model/stream-drain";
import {
  appendAssistantTextOnly,
  appendAssistantToolRound,
  appendToolResultMessages,
} from "../conversation/tool-messages";
import { toolsToCanonical } from "../tools/canonical";
import { parseToolCallArguments } from "../tools/parse-args";
import type { ToolRegistry } from "../tools/registry";
import type { AgentToolExecutionResult } from "../tools/type";
import { toolExecutor } from "../tools/tool-executor";
import { mergeCanonicalTools } from "./merge-tools";
import {
  computeRetryDelayMs,
  DEFAULT_LLM_MAX_RETRIES,
  LLM_RETRY_REMAINING_KEY,
  sleepRetryDelay,
} from "./llm-retry";
import { buildSandboxExecutionContext } from "../sandbox/context";
import type { SandboxRegistry } from "../sandbox/sandbox-registry";
import type { AgentLogger } from "./logger";
import { noopLogger } from "./logger";
import type { LLMClient } from "@renx/provider";
import type { LlmRetryConfig, QueryModelHooks, QueryModelOutcome } from "./types";

export type RunQueryModelLoopParams = {
  initial: QueryModelType;
  maxSteps: number;
  registry: ToolRegistry;
  hooks?: QueryModelHooks;
  middlewares?: AgentMiddleware[];
  sandboxRegistry: SandboxRegistry;
  /**
   * 省略时使用 `DEFAULT_LLM_MAX_RETRIES`。
   */
  llmRetry?: LlmRetryConfig;
  /**
   * 若提供，则 `runtime` 使用该 `LLMClient.streamText`（与 `Agent` 构造参数 `llmClientOptions` 对应）；
   * 省略时仍用 `@renx/provider` 的 `streamText(config)` 默认单例。
   */
  llmClient?: LLMClient;
  /** Structured logger for lifecycle events. */
  logger?: AgentLogger;
};

// ---------------------------------------------------------------------------
// Loop state
// ---------------------------------------------------------------------------

interface LoopState {
  messages: Message[];
  llmRounds: number;
  carry: MiddlewareCarry;
  lastStream: RuntimeOutcome;
  retryDelayAttemptIndex: number;
}

function initLoopState(initial: QueryModelType): LoopState {
  return {
    messages: [...initial.messages],
    llmRounds: 0,
    carry: {},
    lastStream: {
      ok: false,
      error: new Error("No LLM call was made"),
      textStream: (async function* () {})(),
      text: Promise.resolve(""),
      reasoning: Promise.resolve(""),
      toolCalls: Promise.resolve([]),
      usage: Promise.resolve(undefined),
      finishReason: Promise.resolve("error"),
    },
    retryDelayAttemptIndex: 0,
  };
}

// ---------------------------------------------------------------------------
// Outcome helpers
// ---------------------------------------------------------------------------

function stoppedOutcome(
  messages: Message[],
  llmRounds: number,
  lastStream: RuntimeOutcome,
  stopReason?: string,
): QueryModelOutcome {
  return {
    messages,
    finishReason: "stop",
    llmRounds,
    lastStream,
    stopped: true,
    stopReason,
  };
}

function errorOutcome(
  messages: Message[],
  llmRounds: number,
  lastStream: RuntimeOutcome,
  error: unknown,
): QueryModelOutcome {
  return {
    messages,
    finishReason: "error",
    llmRounds,
    lastStream,
    error,
  };
}

function successOutcome(
  messages: Message[],
  finishReason: Awaited<RuntimeOutcome["finishReason"]>,
  llmRounds: number,
  lastStream: RuntimeOutcome,
): QueryModelOutcome {
  return {
    messages,
    finishReason,
    llmRounds,
    lastStream,
  };
}

// ---------------------------------------------------------------------------
// Stage handlers
// ---------------------------------------------------------------------------

function handleMaxStepsExceeded(
  state: LoopState,
  maxSteps: number,
  emitBeforeFinish: (reason: string, error?: unknown) => Promise<QueryModelOutcome | null>,
): Promise<QueryModelOutcome> {
  return (async () => {
    const finishReason = await state.lastStream.finishReason;
    const gated = await emitBeforeFinish("max_steps");
    if (gated) return gated;
    return {
      messages: state.messages,
      finishReason,
      llmRounds: state.llmRounds,
      lastStream: state.lastStream,
      error: new Error(`maxSteps (${maxSteps}) exceeded`),
    };
  })();
}

function handleModelFailure(
  state: LoopState,
  outcome: RuntimeOutcome,
  _finishReason: Awaited<RuntimeOutcome["finishReason"]>,
  emitBeforeFinish: (reason: string, error?: unknown) => Promise<QueryModelOutcome | null>,
): Promise<QueryModelOutcome> {
  return (async () => {
    const err = outcome.ok ? undefined : outcome.error;
    const gated = await emitBeforeFinish("error", err);
    if (gated) return gated;
    return errorOutcome(state.messages, state.llmRounds, outcome, err);
  })();
}

function handleTextResponse(
  state: LoopState,
  outcome: RuntimeOutcome,
  finishReason: Awaited<RuntimeOutcome["finishReason"]>,
  assistantText: string,
  emitBeforeFinish: (reason: string, error?: unknown) => Promise<QueryModelOutcome | null>,
): Promise<QueryModelOutcome> {
  return (async () => {
    state.messages = appendAssistantTextOnly(state.messages, assistantText);
    const gated = await emitBeforeFinish("success");
    if (gated) return gated;
    return successOutcome(state.messages, finishReason, state.llmRounds, outcome);
  })();
}

async function handleToolCalls(
  state: LoopState,
  calls: Awaited<RuntimeOutcome["toolCalls"]>,
  assistantText: string,
  registry: ToolRegistry,
  sandboxRegistry: SandboxRegistry,
  runMiddlewarePhase: (event: AgentEventName, partial: Partial<MiddlewareCarry>) => Promise<QueryModelOutcome | null>,
  logger: AgentLogger,
): Promise<QueryModelOutcome | null> {
  state.messages = appendAssistantToolRound(state.messages, assistantText, calls);

  const invocations = calls.map((call) => {
    const tool = registry.get(call.name);
    if (!tool) {
      throw new Error(`Tool not registered: ${call.name}`);
    }
    const parsed = parseToolCallArguments(call.arguments);
    if (!parsed.ok) {
      logger.warn("parseToolCallArguments failed", {
        toolName: call.name,
        callId: call.id,
        parseError: parsed.parseError,
      });
    }
    return {
      tool,
      args: parsed.args,
      callId: call.id,
    };
  });

  const earlyTool = await runMiddlewarePhase("beforeToolExecution", {
    step: { llmRounds: state.llmRounds },
    toolInvocation: {
      calls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
      invocations: invocations.map((i) => ({
        callId: i.callId,
        name: i.tool.name,
        args: i.args,
      })),
    },
  });
  if (earlyTool) return earlyTool;

  const decision = state.carry.control?.decision;
  const denyToolExecution = decision === "deny" || decision === "block";

  let results: AgentToolExecutionResult[];
  if (denyToolExecution) {
    const msg = state.carry.control?.stopReason ?? "Tool execution was not allowed.";
    results = invocations.map(() => ({
      success: false,
      content: msg,
      metadata: { denied: true, decision },
    }));
    state.carry = {
      ...state.carry,
      control: state.carry.control
        ? { ...state.carry.control, decision: undefined, continue: undefined }
        : undefined,
    };
  } else {
    results = await toolExecutor(invocations, {
      sandboxRegistry,
      getSandboxContext: (tool) => buildSandboxExecutionContext(state.carry, tool),
    });
  }

  const earlyResult = await runMiddlewarePhase("afterToolExecution", {
    step: { llmRounds: state.llmRounds },
    toolResult: { results: cloneContextValue(results) },
  });
  if (earlyResult) return earlyResult;

  state.messages = appendToolResultMessages(state.messages, calls, results);
  return null;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

/**
 * ReAct 风格多轮：单次 LLM → 排空流 → 若非 tool_calls 则结束，否则执行工具并写回 messages 后继续。
 * 与具体 `Agent` 类解耦，便于后续替换为 Harness / ReActLoopEngine 实现而不改调用方测试。
 *
 * 若配置了 `middlewares`（`Agent.use`），在关键阶段触发（见 `AGENT_EVENTS`），
 * 并在 `beforeModelCall` 之后应用 `modelRequest` 中对本次请求的补丁。
 */
export async function runQueryModelLoop(params: RunQueryModelLoopParams): Promise<QueryModelOutcome> {
  const { initial, maxSteps, registry, hooks, middlewares = [], sandboxRegistry, llmRetry, llmClient } =
    params;
  const logger = params.logger ?? noopLogger;
  const state = initLoopState(initial);
  const hasMiddleware = middlewares.length > 0;

  // --- Middleware helpers ---

  async function runMiddlewarePhase(
    event: AgentEventName,
    partial: Partial<MiddlewareCarry>,
  ): Promise<QueryModelOutcome | null> {
    if (!middlewares.length) return null;
    const ctx: AgentMiddlewareContext = {
      event,
      signal: hooks?.signal,
      ...state.carry,
      ...partial,
    };
    await compose(middlewares)(ctx, async () => {});
    state.carry = mergeCarry(state.carry, ctx);
    if (ctx.control?.continue === false) {
      return stoppedOutcome(state.messages, state.llmRounds, state.lastStream, ctx.control?.stopReason);
    }
    return null;
  }

  async function emitBeforeFinish(reason: string, error?: unknown): Promise<QueryModelOutcome | null> {
    return runMiddlewarePhase("beforeFinish", {
      eventData: { reason },
      context: { messages: cloneContextValue(state.messages) },
      error,
    });
  }

  // --- beforeRun ---

  const earlyRun = await runMiddlewarePhase("beforeRun", { run: { maxSteps } });
  if (earlyRun) return earlyRun;

  // --- Initialize retry counter ---

  {
    const key = LLM_RETRY_REMAINING_KEY;
    const existing = (state.carry.shared as Record<string, unknown> | undefined)?.[key];
    if (existing == null) {
      const n =
        llmRetry != null
          ? Math.max(0, Math.floor(llmRetry.maxRetries))
          : DEFAULT_LLM_MAX_RETRIES;
      state.carry = {
        ...state.carry,
        shared: {
          ...state.carry.shared,
          [key]: n,
        },
      };
    }
  }

  // --- Main loop ---

  while (true) {
    if (state.llmRounds >= maxSteps) {
      return handleMaxStepsExceeded(state, maxSteps, emitBeforeFinish);
    }
    state.llmRounds++;

    const earlyStep = await runMiddlewarePhase("beforeStep", { step: { llmRounds: state.llmRounds }, run: { maxSteps } });
    if (earlyStep) return earlyStep;

    const registryCanonical = toolsToCanonical(registry.list());
    const tools = mergeCanonicalTools(registryCanonical, initial.tools);

    const earlyCtx = await runMiddlewarePhase("beforeBuildContext", {
      step: { llmRounds: state.llmRounds },
      run: { maxSteps },
      context: { messages: cloneContextValue(state.messages), llmRounds: state.llmRounds },
      eventData: { tools },
    });
    if (earlyCtx) return earlyCtx;

    const streamConfig: QueryModelType = {
      ...initial,
      messages: state.messages,
      ...(tools ? { tools } : {}),
      toolChoice: initial.toolChoice,
    };

    let effectiveConfig: QueryModelType = streamConfig;
    let suppressOutput = false;

    if (hasMiddleware) {
      const early = await runMiddlewarePhase("beforeModelCall", {
        step: { llmRounds: state.llmRounds },
        run: { maxSteps },
        context: { messages: cloneContextValue(state.messages), llmRounds: state.llmRounds },
        modelRequest: cloneContextValue(streamConfig) as HookPatchBucket,
      });
      if (early) return early;
      suppressOutput = state.carry.control?.suppressOutput === true;
      if (state.carry.modelRequest) {
        const patch = cloneContextValue(state.carry.modelRequest) as Partial<QueryModelType>;
        effectiveConfig = { ...streamConfig, ...patch };
        if (patch.messages) {
          state.messages = [...patch.messages];
        }
        effectiveConfig = { ...effectiveConfig, messages: state.messages };
      }
    }

    // --- Model call with retry ---

    let outcome: RuntimeOutcome;
    let finishReason: Awaited<RuntimeOutcome["finishReason"]>;
    let assistantText: string;
    let calls: Awaited<RuntimeOutcome["toolCalls"]>;
    let usage: Awaited<RuntimeOutcome["usage"]>;

    modelAttemptLoop: while (true) {
      logger.debug("modelCall", { llmRound: state.llmRounds, attempt: state.retryDelayAttemptIndex });
      outcome = await runtime(effectiveConfig, llmClient);
      state.lastStream = outcome;

      await drainTextStream(
        outcome.textStream,
        hooks?.onStreamChunk
          ? (chunk) =>
              hooks.onStreamChunk!(chunk, {
                llmRound: state.llmRounds,
                suppressOutput,
              })
          : undefined,
      );

      [finishReason, assistantText, calls, usage] = await Promise.all([
        outcome.finishReason,
        outcome.text,
        outcome.toolCalls,
        outcome.usage,
      ]);

      if (hasMiddleware) {
        const early = await runMiddlewarePhase("afterModelCall", {
          step: { llmRounds: state.llmRounds },
          modelResponse: {
            ok: outcome.ok,
            finishReason,
            assistantText,
            toolCalls: calls,
            usage,
            llmRound: state.llmRounds,
          },
          error: outcome.ok ? undefined : outcome.error,
        });
        if (early) return early;
      }

      if (outcome.ok) {
        break modelAttemptLoop;
      }

      logger.warn("modelCallFailed", { llmRound: state.llmRounds, error: String(outcome.error) });

      const key = LLM_RETRY_REMAINING_KEY;
      const remaining = (state.carry.shared as Record<string, unknown> | undefined)?.[key];
      if (typeof remaining === "number" && remaining > 0) {
        const allowRetry =
          llmRetry?.isRetryable == null
            ? true
            : llmRetry.isRetryable({ error: outcome.error, model: effectiveConfig.model });
        if (allowRetry) {
          state.carry = {
            ...state.carry,
            shared: {
              ...state.carry.shared,
              [key]: remaining - 1,
            },
          };
          const delayMs = computeRetryDelayMs(llmRetry, state.retryDelayAttemptIndex);
          state.retryDelayAttemptIndex += 1;
          await sleepRetryDelay(delayMs, hooks?.signal);
          continue modelAttemptLoop;
        }
      }
      break modelAttemptLoop;
    }

    // --- Handle result ---

    if (!outcome.ok) {
      return handleModelFailure(state, outcome, finishReason, emitBeforeFinish);
    }

    if (finishReason !== "tool_calls" || calls.length === 0) {
      return handleTextResponse(state, outcome, finishReason, assistantText, emitBeforeFinish);
    }

    const toolResult = await handleToolCalls(
      state,
      calls,
      assistantText,
      registry,
      sandboxRegistry,
      runMiddlewarePhase,
      logger,
    );
    if (toolResult) return toolResult;
  }
}
