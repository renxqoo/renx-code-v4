import type { LLMClient } from "@renx/provider";
import {
  createDefaultRunProfile,
  mergeRunProfile,
  type AgentFeatureFlagValue,
  type AgentHook,
  type AgentHookEvent,
  type ResolvedRunProfile,
} from "../agent/hooks";
import {
  DEFAULT_LLM_MAX_RETRIES,
} from "../agent/llm-retry";
import type { AgentLogger } from "../agent/logger";
import { noopLogger } from "../agent/logger";
import type { LlmRetryConfig, QueryModelHooks, QueryModelOutcome } from "../agent/types";
import { appendAssistantTextOnly } from "../conversation/tool-messages";
import type { Message } from "../domain/message";
import type { RuntimeOutcome } from "../model/runtime";
import type { SandboxRegistry } from "../sandbox/sandbox-registry";
import type { ToolRegistry } from "../tools/registry";
import type { ContextBuilder } from "./context-builder";
import { ReActLoopEngine } from "./react-loop-engine";
import type {
  AgentRunRecord,
  AgentRunSummary,
  AgentRuntimeEvent,
} from "./session-store";
import type { SummaryManager } from "./summary-manager";
import type { AgentTelemetrySink } from "./telemetry";
import { noopTelemetry } from "./telemetry";
import type { TerminationPolicy } from "./termination-policy";
import { ToolCallProcessor } from "./tool-call-processor";
import { ToolRuntime } from "./tool-runtime";

type HarnessDependencies = {
  maxSteps: number;
  registry: ToolRegistry;
  sandboxRegistry: SandboxRegistry;
  hooks?: QueryModelHooks;
  enterpriseHooks?: AgentHook[];
  llmRetry?: LlmRetryConfig;
  llmClient?: LLMClient;
  logger?: AgentLogger;
  terminationPolicy: TerminationPolicy;
  contextBuilder: ContextBuilder;
  summaryManager: SummaryManager;
  telemetry?: AgentTelemetrySink;
  recordEvents?: (events: AgentRuntimeEvent[]) => Promise<void>;
  persistRun?: (patch: Partial<AgentRunRecord>) => Promise<void>;
};

interface LoopState {
  messages: Message[];
  summary?: AgentRunSummary;
  llmRounds: number;
  lastStream: RuntimeOutcome;
  retryRemaining: number;
  retryDelayAttemptIndex: number;
  profile: ResolvedRunProfile;
}

export type HarnessOutcome = QueryModelOutcome;

function initLoopState(run: AgentRunRecord, llmRetry?: LlmRetryConfig): LoopState {
  return {
    messages: [...run.messages],
    summary: run.summary,
    llmRounds: run.llmRounds,
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
    retryRemaining:
      llmRetry != null ? Math.max(0, Math.floor(llmRetry.maxRetries)) : DEFAULT_LLM_MAX_RETRIES,
    retryDelayAttemptIndex: 0,
    profile: createDefaultRunProfile(),
  };
}

export class Harness {
  private readonly maxSteps: number;
  private readonly hooks?: QueryModelHooks;
  private readonly enterpriseHooks: AgentHook[];
  private readonly llmRetry?: LlmRetryConfig;
  private readonly logger: AgentLogger;
  private readonly terminationPolicy: TerminationPolicy;
  private readonly toolRuntime: ToolRuntime;
  private readonly toolCallProcessor: ToolCallProcessor;
  private readonly reactLoopEngine: ReActLoopEngine;
  private readonly summaryManager: SummaryManager;
  private readonly telemetry: AgentTelemetrySink;
  private readonly recordEvents?: (events: AgentRuntimeEvent[]) => Promise<void>;
  private readonly persistRun?: (patch: Partial<AgentRunRecord>) => Promise<void>;

  constructor(deps: HarnessDependencies) {
    this.maxSteps = deps.maxSteps;
    this.hooks = deps.hooks;
    this.enterpriseHooks = deps.enterpriseHooks ?? [];
    this.llmRetry = deps.llmRetry;
    this.logger = deps.logger ?? noopLogger;
    this.terminationPolicy = deps.terminationPolicy;
    this.toolRuntime = new ToolRuntime(deps.registry, deps.sandboxRegistry, this.logger);
    this.reactLoopEngine = new ReActLoopEngine({
      registry: deps.registry,
      hooks: this.hooks,
      llmRetry: this.llmRetry,
      llmClient: deps.llmClient,
      logger: this.logger,
      contextBuilder: deps.contextBuilder,
      emitEvent: (event) => this.emitEvent(event),
      pushEvents: (events) => this.pushEvents(events),
      captureTelemetry: (event) => this.captureTelemetry(event),
    });
    this.toolCallProcessor = new ToolCallProcessor({
      toolRuntime: this.toolRuntime,
      enterpriseHooks: this.enterpriseHooks,
      emitEvent: (event) => this.emitEvent(event),
      pushEvents: (events) => this.pushEvents(events),
      captureTelemetry: (event) => this.captureTelemetry(event),
    });
    this.summaryManager = deps.summaryManager;
    this.telemetry = deps.telemetry ?? noopTelemetry;
    this.recordEvents = deps.recordEvents;
    this.persistRun = deps.persistRun;
  }

  async run(run: AgentRunRecord): Promise<HarnessOutcome> {
    const state = initLoopState(run, this.llmRetry);
    state.profile = await this.resolveRunProfile(run);
    await this.emitEvent({
      type: "run_started",
      runId: run.runId,
      maxSteps: this.maxSteps,
      model: state.profile.overrides.model ?? run.initial.model,
      ...this.hookContext(state.profile),
    });

    while (true) {
      if (state.llmRounds >= this.maxSteps) {
        const finishReason = await state.lastStream.finishReason;
        const outcome: HarnessOutcome = {
          runId: run.runId,
          status: "failed",
          messages: state.messages,
          summary: state.summary,
          finishReason,
          llmRounds: state.llmRounds,
          lastStream: state.lastStream,
          error: new Error(`maxSteps (${this.maxSteps}) exceeded`),
          stopReason: "max_steps",
        };
        await this.emitTerminalEvent(outcome, state.profile);
        return outcome;
      }

      state.llmRounds++;
      await this.emitEvent({
        type: "step_started",
        runId: run.runId,
        llmRound: state.llmRounds,
        messageCount: state.messages.length,
        ...this.hookContext(state.profile),
      });
      await this.pushEvents([
        {
          type: "step_started",
          runId: run.runId,
          at: new Date().toISOString(),
          stepIndex: state.llmRounds,
          llmRound: state.llmRounds,
          messageCount: state.messages.length,
        },
      ]);

      const step = await this.reactLoopEngine.executeStep({
        run,
        llmRound: state.llmRounds,
        messages: state.messages,
        summary: state.summary,
        profile: state.profile,
        retryRemaining: state.retryRemaining,
        retryDelayAttemptIndex: state.retryDelayAttemptIndex,
      });
      state.lastStream = step.lastStream;
      state.retryRemaining = step.retryRemaining;
      state.retryDelayAttemptIndex = step.retryDelayAttemptIndex;
      const decision = step.decision;

      const termination = this.terminationPolicy.evaluate({
        llmRounds: state.llmRounds,
        maxSteps: this.maxSteps,
        decision,
      });

      if (decision.type === "error") {
        const failure: HarnessOutcome = {
          runId: run.runId,
          status: "failed",
          messages: state.messages,
          summary: state.summary,
          finishReason: "error",
          llmRounds: state.llmRounds,
          lastStream: step.lastStream,
          error: decision.error,
          stopReason: "model_error",
        };
        await this.emitTerminalEvent(failure, state.profile);
        return failure;
      }

      if (decision.type === "final_answer") {
        state.messages = appendAssistantTextOnly(state.messages, decision.assistantText);
        await this.refreshSummary(run, state);
        await this.persistProgress(run, state);
        const finalOutcome: HarnessOutcome = {
          runId: run.runId,
          status: "finished",
          messages: state.messages,
          summary: state.summary,
          finishReason: decision.finishReason,
          llmRounds: state.llmRounds,
          lastStream: step.lastStream,
        };
        await this.emitTerminalEvent(finalOutcome, state.profile);
        return finalOutcome;
      }

      const toolProcessing = await this.toolCallProcessor.process({
        run,
        llmRound: state.llmRounds,
        decision,
        messages: state.messages,
        profile: state.profile,
        signal: this.hooks?.signal,
      });

      if (toolProcessing.type === "abort") {
        const failure: HarnessOutcome = {
          runId: run.runId,
          status: "failed",
          messages: toolProcessing.messages,
          summary: state.summary,
          finishReason: "stop",
          llmRounds: state.llmRounds,
          lastStream: state.lastStream,
          error: new Error(toolProcessing.reason),
          stopReason: toolProcessing.reason,
        };
        await this.emitTerminalEvent(failure, state.profile);
        return failure;
      }

      if (toolProcessing.type === "pause") {
        return {
          runId: run.runId,
          status: "waiting_permission",
          messages: toolProcessing.messages,
          summary: state.summary,
          finishReason: "stop",
          llmRounds: state.llmRounds,
          lastStream: state.lastStream,
          stopReason: toolProcessing.reason,
          pendingApproval: toolProcessing.pendingApproval,
        };
      }

      state.messages = toolProcessing.messages;
      await this.refreshSummary(run, state);
      await this.persistProgress(run, state);

      if (termination.shouldStop) {
        const terminalOutcome: HarnessOutcome = {
          runId: run.runId,
          status: termination.error ? "failed" : "finished",
          messages: state.messages,
          summary: state.summary,
          finishReason: decision.finishReason,
          llmRounds: state.llmRounds,
          lastStream: state.lastStream,
          error: termination.error,
          stopReason: termination.reason,
        };
        await this.emitTerminalEvent(terminalOutcome, state.profile);
        return terminalOutcome;
      }
    }
  }

  private async refreshSummary(run: AgentRunRecord, state: LoopState): Promise<void> {
    const nextSummary = await this.summaryManager.maybeUpdate({
      run: {
        ...run,
        messages: state.messages,
        llmRounds: state.llmRounds,
        summary: state.summary,
      },
      messages: state.messages,
    });

    if (!nextSummary || JSON.stringify(nextSummary) === JSON.stringify(state.summary)) {
      return;
    }

    state.summary = nextSummary;
    await this.pushEvents([
      {
        type: "summary_updated",
        runId: run.runId,
        at: new Date().toISOString(),
        summary: nextSummary,
      },
    ]);
  }

  private async persistProgress(run: AgentRunRecord, state: LoopState): Promise<void> {
    await this.persistRun?.({
      runId: run.runId,
      messages: state.messages,
      llmRounds: state.llmRounds,
      summary: state.summary,
      status: "running",
    });
  }

  private async resolveRunProfile(run: AgentRunRecord): Promise<ResolvedRunProfile> {
    let profile = createDefaultRunProfile();
    for (const hook of this.enterpriseHooks) {
      const patch = await hook.assignRunProfile?.({
        runId: run.runId,
        maxSteps: this.maxSteps,
        initial: run.initial,
        signal: this.hooks?.signal,
      });
      profile = mergeRunProfile(profile, patch);
    }
    return profile;
  }

  private async pushEvents(events: AgentRuntimeEvent[]): Promise<void> {
    await this.recordEvents?.(events);
  }

  private hookContext(profile: ResolvedRunProfile): {
    labels: Record<string, string>;
    featureFlags: Record<string, AgentFeatureFlagValue>;
  } {
    return {
      labels: profile.labels,
      featureFlags: profile.featureFlags,
    };
  }

  private async emitTerminalEvent(outcome: HarnessOutcome, profile: ResolvedRunProfile): Promise<void> {
    if (outcome.status !== "finished" && outcome.status !== "failed") {
      return;
    }
    await this.emitEvent({
      type: "run_finished",
      runId: outcome.runId,
      finishReason: outcome.finishReason,
      llmRounds: outcome.llmRounds,
      stopped: outcome.stopReason != null,
      stopReason: outcome.stopReason,
      error: outcome.error,
      ...this.hookContext(profile),
    });
  }

  private async emitEvent(event: AgentHookEvent): Promise<void> {
    for (const hook of this.enterpriseHooks) {
      try {
        await hook.onEvent?.(event);
      } catch (error) {
        this.logger.warn("agentHookEventFailed", {
          hookName: hook.name ?? "anonymous",
          eventType: event.type,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async captureTelemetry(event: import("./telemetry").AgentTelemetryEvent): Promise<void> {
    try {
      await this.telemetry.capture(event);
    } catch (error) {
      this.logger.warn("agentTelemetryFailed", {
        eventName: event.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
