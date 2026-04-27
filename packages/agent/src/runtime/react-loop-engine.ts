import type { CanonicalTool } from "@renx/provider";
import type { LLMClient } from "@renx/provider";
import type { AgentHookEvent, ResolvedRunProfile } from "../agent/hooks";
import {
  computeRetryDelayMs,
  DEFAULT_LLM_MAX_RETRIES,
  sleepRetryDelay,
} from "../agent/llm-retry";
import type { AgentLogger } from "../agent/logger";
import { noopLogger } from "../agent/logger";
import type { LlmRetryConfig, QueryModelHooks } from "../agent/types";
import { runtime, type RuntimeOutcome } from "../model/runtime";
import { drainTextStream } from "../model/stream-drain";
import { toolsToCanonical } from "../tools/canonical";
import type { ToolRegistry } from "../tools/registry";
import type { ContextBuilder } from "./context-builder";
import { DecisionRouter, type AgentDecision } from "./decision-router";
import type { AgentRunRecord, AgentRunSummary, AgentRuntimeEvent } from "./session-store";
import type { AgentTelemetryEvent } from "./telemetry";

export type ReActLoopStepInput = {
  run: AgentRunRecord;
  llmRound: number;
  messages: AgentRunRecord["messages"];
  summary?: AgentRunSummary;
  profile: ResolvedRunProfile;
  retryRemaining?: number;
  retryDelayAttemptIndex?: number;
};

export type ReActLoopStepResult = {
  decision: AgentDecision;
  lastStream: RuntimeOutcome;
  retryRemaining: number;
  retryDelayAttemptIndex: number;
};

export type ReActLoopEngineDependencies = {
  registry: ToolRegistry;
  hooks?: QueryModelHooks;
  llmRetry?: LlmRetryConfig;
  llmClient?: LLMClient;
  logger?: AgentLogger;
  contextBuilder: ContextBuilder;
  emitEvent?: (event: AgentHookEvent) => Promise<void>;
  pushEvents?: (events: AgentRuntimeEvent[]) => Promise<void>;
  captureTelemetry?: (event: AgentTelemetryEvent) => Promise<void>;
};

export class ReActLoopEngine {
  private readonly registry: ToolRegistry;
  private readonly hooks?: QueryModelHooks;
  private readonly llmRetry?: LlmRetryConfig;
  private readonly llmClient?: LLMClient;
  private readonly logger: AgentLogger;
  private readonly contextBuilder: ContextBuilder;
  private readonly decisionRouter = new DecisionRouter();
  private readonly emitEvent?: (event: AgentHookEvent) => Promise<void>;
  private readonly pushEvents?: (events: AgentRuntimeEvent[]) => Promise<void>;
  private readonly captureTelemetry?: (event: AgentTelemetryEvent) => Promise<void>;

  constructor(deps: ReActLoopEngineDependencies) {
    this.registry = deps.registry;
    this.hooks = deps.hooks;
    this.llmRetry = deps.llmRetry;
    this.llmClient = deps.llmClient;
    this.logger = deps.logger ?? noopLogger;
    this.contextBuilder = deps.contextBuilder;
    this.emitEvent = deps.emitEvent;
    this.pushEvents = deps.pushEvents;
    this.captureTelemetry = deps.captureTelemetry;
  }

  async executeStep(input: ReActLoopStepInput): Promise<ReActLoopStepResult> {
    let retryRemaining =
      input.retryRemaining != null
        ? Math.max(0, Math.floor(input.retryRemaining))
        : this.llmRetry != null
          ? Math.max(0, Math.floor(this.llmRetry.maxRetries))
          : DEFAULT_LLM_MAX_RETRIES;
    let retryDelayAttemptIndex = Math.max(0, input.retryDelayAttemptIndex ?? 0);

    while (true) {
      const modelStartedAt = Date.now();
      const tools = mergeCanonicalTools(toolsToCanonical(this.registry.list()), input.run.initial.tools);
      const streamConfig = await this.contextBuilder.build({
        run: {
          ...input.run,
          messages: input.messages,
          llmRounds: input.llmRound,
          summary: input.summary,
        },
        profile: input.profile,
        tools,
      });

      await this.emitEvent?.({
        type: "model_started",
        runId: input.run.runId,
        llmRound: input.llmRound,
        model: streamConfig.model,
        toolCount: tools?.length ?? 0,
        messageCount: input.messages.length,
        ...hookContext(input.profile),
      });

      this.logger.debug("modelCall", {
        runId: input.run.runId,
        llmRound: input.llmRound,
        retryRemaining,
        attempt: retryDelayAttemptIndex,
      });

      const outcome = await runtime(streamConfig, this.llmClient);

      const onStreamChunk = this.hooks?.onStreamChunk;
      await drainTextStream(
        outcome.textStream,
        onStreamChunk
          ? (chunk) =>
              onStreamChunk(chunk, {
                llmRound: input.llmRound,
                suppressOutput: input.profile.suppressStreaming,
              })
          : undefined,
      );

      const [finishReason, assistantText, toolCalls, usage] = await Promise.all([
        outcome.finishReason,
        outcome.text,
        outcome.toolCalls,
        outcome.usage,
      ]);

      await this.pushEvents?.([
        {
          type: "model_completed",
          runId: input.run.runId,
          at: new Date().toISOString(),
          stepIndex: input.llmRound,
          llmRound: input.llmRound,
          ok: outcome.ok,
          finishReason,
          assistantText,
          toolCalls,
          usage,
          error: outcome.ok ? undefined : outcome.error,
        },
      ]);

      await this.emitEvent?.({
        type: "model_completed",
        runId: input.run.runId,
        llmRound: input.llmRound,
        ok: outcome.ok,
        finishReason,
        assistantText,
        toolCalls,
        usage,
        error: outcome.ok ? undefined : outcome.error,
        ...hookContext(input.profile),
      });

      await this.captureTelemetry?.({
        name: "model_completed",
        at: new Date().toISOString(),
        runId: input.run.runId,
        llmRound: input.llmRound,
        durationMs: Date.now() - modelStartedAt,
        finishReason,
        success: outcome.ok,
        metadata: {
          toolCallCount: toolCalls.length,
          usage,
          model: streamConfig.model,
        },
      });

      if (outcome.ok) {
        return {
          decision: this.decisionRouter.route({
            outcome,
            finishReason,
            assistantText,
            toolCalls,
            usage,
          }),
          lastStream: outcome,
          retryRemaining,
          retryDelayAttemptIndex,
        };
      }

      this.logger.warn("modelCallFailed", {
        runId: input.run.runId,
        llmRound: input.llmRound,
        error: String(outcome.error),
      });

      const allowRetry =
        retryRemaining > 0 &&
        (this.llmRetry?.isRetryable == null
          ? true
          : this.llmRetry.isRetryable({ error: outcome.error, model: streamConfig.model }));
      if (!allowRetry) {
        return {
          decision: this.decisionRouter.route({
            outcome,
            finishReason,
            assistantText,
            toolCalls,
            usage,
          }),
          lastStream: outcome,
          retryRemaining,
          retryDelayAttemptIndex,
        };
      }

      retryRemaining -= 1;
      const delayMs = computeRetryDelayMs(this.llmRetry, retryDelayAttemptIndex);
      retryDelayAttemptIndex += 1;
      await sleepRetryDelay(delayMs, this.hooks?.signal);
    }
  }
}

function hookContext(profile: ResolvedRunProfile): {
  labels: Record<string, string>;
  featureFlags: Record<string, import("../agent/hooks").AgentFeatureFlagValue>;
} {
  return {
    labels: profile.labels,
    featureFlags: profile.featureFlags,
  };
}

function mergeCanonicalTools(
  registryTools: CanonicalTool[] | undefined,
  inputTools: CanonicalTool[] | undefined,
): CanonicalTool[] | undefined {
  if (!registryTools?.length && !inputTools?.length) return undefined;
  if (!registryTools?.length) return inputTools;
  if (!inputTools?.length) return registryTools;

  const merged = new Map<string, CanonicalTool>();
  for (const tool of registryTools) merged.set(tool.name, tool);
  for (const tool of inputTools) merged.set(tool.name, tool);
  return [...merged.values()];
}
