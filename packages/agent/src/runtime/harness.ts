import type { CanonicalTool } from "@renx/provider";
import type { LLMClient } from "@renx/provider";
import {
  createDefaultRunProfile,
  mergeRunProfile,
  type AgentHook,
  type AgentHookEvent,
  type AgentRunProfilePatch,
  type AgentToolAuthorizationResult,
  type AgentToolInvocation,
  type ResolvedRunProfile,
} from "../agent/hooks";
import {
  computeRetryDelayMs,
  DEFAULT_LLM_MAX_RETRIES,
  sleepRetryDelay,
} from "../agent/llm-retry";
import type { AgentLogger } from "../agent/logger";
import { noopLogger } from "../agent/logger";
import type { LlmRetryConfig, QueryModelHooks, QueryModelOutcome } from "../agent/types";
import {
  appendAssistantTextOnly,
  appendAssistantToolRound,
  appendToolResultMessages,
} from "../conversation/tool-messages";
import type { Message } from "../domain/message";
import type { QueryModelType } from "../domain/query-model";
import { runtime, type RuntimeOutcome } from "../model/runtime";
import { drainTextStream } from "../model/stream-drain";
import type { SandboxRegistry } from "../sandbox/sandbox-registry";
import { toolsToCanonical } from "../tools/canonical";
import type { ToolRegistry } from "../tools/registry";
import type { AgentToolExecutionResult } from "../tools/type";
import { DecisionRouter } from "./decision-router";
import type { RunStateMachine } from "./run-state-machine";
import type { TerminationPolicy } from "./termination-policy";
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
  runStateMachine: RunStateMachine;
};

interface LoopState {
  messages: Message[];
  llmRounds: number;
  lastStream: RuntimeOutcome;
  retryRemaining: number;
  retryDelayAttemptIndex: number;
  profile: ResolvedRunProfile;
}

function initLoopState(initial: QueryModelType, llmRetry?: LlmRetryConfig): LoopState {
  return {
    messages: [...initial.messages],
    llmRounds: 0,
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

function successOutcome(
  messages: Message[],
  finishReason: Awaited<RuntimeOutcome["finishReason"]>,
  llmRounds: number,
  lastStream: RuntimeOutcome,
  runId: string,
): QueryModelOutcome {
  return {
    runId,
    messages,
    finishReason,
    llmRounds,
    lastStream,
  };
}

function errorOutcome(
  messages: Message[],
  llmRounds: number,
  lastStream: RuntimeOutcome,
  error: unknown,
  runId: string,
): QueryModelOutcome {
  return {
    runId,
    messages,
    finishReason: "error",
    llmRounds,
    lastStream,
    error,
  };
}

function stoppedOutcome(
  messages: Message[],
  llmRounds: number,
  lastStream: RuntimeOutcome,
  stopReason: string | undefined,
  runId: string,
): QueryModelOutcome {
  return {
    runId,
    messages,
    finishReason: "stop",
    llmRounds,
    lastStream,
    stopped: true,
    stopReason,
  };
}

export class Harness {
  private readonly maxSteps: number;
  private readonly registry: ToolRegistry;
  private readonly hooks?: QueryModelHooks;
  private readonly enterpriseHooks: AgentHook[];
  private readonly llmRetry?: LlmRetryConfig;
  private readonly llmClient?: LLMClient;
  private readonly logger: AgentLogger;
  private readonly terminationPolicy: TerminationPolicy;
  private readonly runStateMachine: RunStateMachine;
  private readonly decisionRouter = new DecisionRouter();
  private readonly toolRuntime: ToolRuntime;

  constructor(deps: HarnessDependencies) {
    this.maxSteps = deps.maxSteps;
    this.registry = deps.registry;
    this.hooks = deps.hooks;
    this.enterpriseHooks = deps.enterpriseHooks ?? [];
    this.llmRetry = deps.llmRetry;
    this.llmClient = deps.llmClient;
    this.logger = deps.logger ?? noopLogger;
    this.terminationPolicy = deps.terminationPolicy;
    this.runStateMachine = deps.runStateMachine;
    this.toolRuntime = new ToolRuntime(deps.registry, deps.sandboxRegistry, this.logger);
  }

  async run(initial: QueryModelType): Promise<QueryModelOutcome> {
    const state = initLoopState(initial, this.llmRetry);
    state.profile = await this.resolveRunProfile(initial);

    await this.emitEvent({
      type: "run_started",
      runId: this.runStateMachine.runId,
      maxSteps: this.maxSteps,
      model: state.profile.overrides.model ?? initial.model,
      labels: state.profile.labels,
      featureFlags: state.profile.featureFlags,
    });

    while (true) {
      if (state.llmRounds >= this.maxSteps) {
        const finishReason = await state.lastStream.finishReason;
        const outcome: QueryModelOutcome = {
          runId: this.runStateMachine.runId,
          messages: state.messages,
          finishReason,
          llmRounds: state.llmRounds,
          lastStream: state.lastStream,
          error: new Error(`maxSteps (${this.maxSteps}) exceeded`),
        };
        await this.emitRunFinished(outcome, state.profile);
        return outcome;
      }

      state.llmRounds++;
      await this.runStateMachine.beginStep(state.llmRounds, state.llmRounds, state.messages);
      await this.emitEvent({
        type: "step_started",
        runId: this.runStateMachine.runId,
        llmRound: state.llmRounds,
        messageCount: state.messages.length,
        labels: state.profile.labels,
        featureFlags: state.profile.featureFlags,
      });

      await this.runStateMachine.persistStep({
        stepIndex: state.llmRounds,
        llmRound: state.llmRounds,
        status: "building_context",
        messages: state.messages,
      });

      const streamConfig = this.buildStreamConfig(initial, state.messages, state.profile);

      await this.runStateMachine.persistStep({
        stepIndex: state.llmRounds,
        llmRound: state.llmRounds,
        status: "calling_model",
        messages: state.messages,
      });

      await this.emitEvent({
        type: "model_started",
        runId: this.runStateMachine.runId,
        llmRound: state.llmRounds,
        model: streamConfig.model,
        toolCount: streamConfig.tools?.length ?? 0,
        messageCount: streamConfig.messages.length,
        labels: state.profile.labels,
        featureFlags: state.profile.featureFlags,
      });

      let outcome: RuntimeOutcome;
      let finishReason: Awaited<RuntimeOutcome["finishReason"]>;
      let assistantText: string;
      let calls: Awaited<RuntimeOutcome["toolCalls"]>;
      let usage: Awaited<RuntimeOutcome["usage"]>;

      modelAttemptLoop: while (true) {
        this.logger.debug("modelCall", {
          runId: this.runStateMachine.runId,
          llmRound: state.llmRounds,
          retryRemaining: state.retryRemaining,
          attempt: state.retryDelayAttemptIndex,
        });

        outcome = await runtime(streamConfig, this.llmClient);
        state.lastStream = outcome;

        const onStreamChunk = this.hooks?.onStreamChunk;
        await drainTextStream(
          outcome.textStream,
          onStreamChunk
            ? (chunk) =>
                onStreamChunk(chunk, {
                  llmRound: state.llmRounds,
                  suppressOutput: state.profile.suppressStreaming,
                })
            : undefined,
        );

        [finishReason, assistantText, calls, usage] = await Promise.all([
          outcome.finishReason,
          outcome.text,
          outcome.toolCalls,
          outcome.usage,
        ]);

        await this.emitEvent({
          type: "model_completed",
          runId: this.runStateMachine.runId,
          llmRound: state.llmRounds,
          ok: outcome.ok,
          finishReason,
          assistantText,
          toolCalls: calls,
          usage,
          error: outcome.ok ? undefined : outcome.error,
          labels: state.profile.labels,
          featureFlags: state.profile.featureFlags,
        });

        if (outcome.ok) break modelAttemptLoop;

        this.logger.warn("modelCallFailed", {
          runId: this.runStateMachine.runId,
          llmRound: state.llmRounds,
          error: String(outcome.error),
        });

        const allowRetry =
          state.retryRemaining > 0 &&
          (this.llmRetry?.isRetryable == null
            ? true
            : this.llmRetry.isRetryable({ error: outcome.error, model: streamConfig.model }));
        if (!allowRetry) {
          break modelAttemptLoop;
        }

        state.retryRemaining -= 1;
        const delayMs = computeRetryDelayMs(this.llmRetry, state.retryDelayAttemptIndex);
        state.retryDelayAttemptIndex += 1;
        await sleepRetryDelay(delayMs, this.hooks?.signal);
      }

      await this.runStateMachine.persistStep({
        stepIndex: state.llmRounds,
        llmRound: state.llmRounds,
        status: "dispatching_decision",
        messages: state.messages,
        assistantText,
        toolCalls: calls,
        finishReason,
        usage,
        error: outcome.ok ? undefined : outcome.error,
      });

      const decision = this.decisionRouter.route({
        outcome,
        finishReason,
        assistantText,
        toolCalls: calls,
        usage,
      });

      const termination = this.terminationPolicy.evaluate({
        llmRounds: state.llmRounds,
        maxSteps: this.maxSteps,
        decision,
      });

      if (decision.type === "error") {
        await this.runStateMachine.persistStep({
          stepIndex: state.llmRounds,
          llmRound: state.llmRounds,
          status: "failed",
          messages: state.messages,
          finishReason,
          usage,
          error: decision.error,
        });
        const result = errorOutcome(
          state.messages,
          state.llmRounds,
          outcome,
          decision.error,
          this.runStateMachine.runId,
        );
        await this.emitRunFinished(result, state.profile);
        return result;
      }

      if (decision.type === "final_answer") {
        state.messages = appendAssistantTextOnly(state.messages, decision.assistantText);
        await this.runStateMachine.persistStep({
          stepIndex: state.llmRounds,
          llmRound: state.llmRounds,
          status: "completed",
          messages: state.messages,
          assistantText: decision.assistantText,
          toolCalls: decision.toolCalls,
          finishReason: decision.finishReason,
          usage: decision.usage,
        });
        const result = successOutcome(
          state.messages,
          decision.finishReason,
          state.llmRounds,
          outcome,
          this.runStateMachine.runId,
        );
        await this.emitRunFinished(result, state.profile);
        return result;
      }

      await this.runStateMachine.persistStep({
        stepIndex: state.llmRounds,
        llmRound: state.llmRounds,
        status: "executing_tools",
        messages: state.messages,
        assistantText: decision.assistantText,
        toolCalls: decision.toolCalls,
        finishReason: decision.finishReason,
        usage: decision.usage,
      });

      state.messages = appendAssistantToolRound(state.messages, decision.assistantText, decision.toolCalls);
      const invocations = this.toolRuntime.prepare(decision.toolCalls);
      const hookInvocations: AgentToolInvocation[] = invocations.map((invocation) => ({
        callId: invocation.callId,
        name: invocation.tool.name,
        args: invocation.args,
      }));

      await this.emitEvent({
        type: "tool_authorization_requested",
        runId: this.runStateMachine.runId,
        llmRound: state.llmRounds,
        invocations: hookInvocations,
        labels: state.profile.labels,
        featureFlags: state.profile.featureFlags,
      });

      const authorization = await this.authorizeTools(state, hookInvocations);
      const deniedCallIds = authorization.action === "deny" ? authorization.callIds ?? [] : undefined;

      await this.emitEvent({
        type: "tool_authorization_resolved",
        runId: this.runStateMachine.runId,
        llmRound: state.llmRounds,
        action: authorization.action,
        deniedCallIds,
        reason: "reason" in authorization ? authorization.reason : undefined,
        labels: state.profile.labels,
        featureFlags: state.profile.featureFlags,
      });

      if (authorization.action === "abort") {
        const result = stoppedOutcome(
          state.messages,
          state.llmRounds,
          state.lastStream,
          authorization.reason,
          this.runStateMachine.runId,
        );
        await this.emitRunFinished(result, state.profile);
        return result;
      }

      if (authorization.action === "pause") {
        await this.runStateMachine.markWaiting("waiting_permission");
        const result = stoppedOutcome(
          state.messages,
          state.llmRounds,
          state.lastStream,
          authorization.reason,
          this.runStateMachine.runId,
        );
        await this.emitRunFinished(result, state.profile);
        return result;
      }

      const results = await this.executeAuthorizedTools(invocations, authorization, state.profile);
      state.messages = appendToolResultMessages(state.messages, decision.toolCalls, results);

      await this.emitEvent({
        type: "tool_completed",
        runId: this.runStateMachine.runId,
        llmRound: state.llmRounds,
        results,
        labels: state.profile.labels,
        featureFlags: state.profile.featureFlags,
      });

      const terminationError = termination.shouldStop ? termination.error : undefined;
      await this.runStateMachine.persistStep({
        stepIndex: state.llmRounds,
        llmRound: state.llmRounds,
        status: termination.shouldStop ? "completed" : "evaluating_termination",
        messages: state.messages,
        assistantText: decision.assistantText,
        toolCalls: decision.toolCalls,
        finishReason: decision.finishReason,
        usage: decision.usage,
        error: terminationError,
      });

      if (termination.shouldStop) {
        const result = terminationError
          ? errorOutcome(
              state.messages,
              state.llmRounds,
              state.lastStream,
              terminationError,
              this.runStateMachine.runId,
            )
          : successOutcome(
              state.messages,
              decision.finishReason,
              state.llmRounds,
              state.lastStream,
              this.runStateMachine.runId,
            );
        await this.emitRunFinished(result, state.profile);
        return result;
      }

      this.runStateMachine.setMessages(state.messages);
    }
  }

  private buildStreamConfig(
    initial: QueryModelType,
    messages: Message[],
    profile: ResolvedRunProfile,
  ): QueryModelType {
    const registryCanonical = toolsToCanonical(this.registry.list());
    const tools = mergeCanonicalTools(registryCanonical, initial.tools);
    const providerOptions = mergeProviderOptions(initial.providerOptions, profile.overrides.providerOptions);

    return {
      ...initial,
      ...profile.overrides,
      model: profile.overrides.model ?? initial.model,
      providerOptions,
      messages,
      ...(tools ? { tools } : {}),
      toolChoice: profile.overrides.toolChoice ?? initial.toolChoice,
    };
  }

  private async resolveRunProfile(initial: QueryModelType): Promise<ResolvedRunProfile> {
    let profile = createDefaultRunProfile();
    for (const hook of this.enterpriseHooks) {
      const patch = await hook.assignRunProfile?.({
        runId: this.runStateMachine.runId,
        maxSteps: this.maxSteps,
        initial,
        signal: this.hooks?.signal,
      });
      profile = mergeRunProfile(profile, patch);
    }
    return profile;
  }

  private async authorizeTools(
    state: LoopState,
    invocations: AgentToolInvocation[],
  ): Promise<AgentToolAuthorizationResult> {
    const denied = new Map<string, string>();

    for (const hook of this.enterpriseHooks) {
      const decision = await hook.authorizeTools?.({
        runId: this.runStateMachine.runId,
        llmRound: state.llmRounds,
        messages: state.messages,
        invocations,
        labels: state.profile.labels,
        featureFlags: state.profile.featureFlags,
        signal: this.hooks?.signal,
      });
      if (!decision || decision.action === "allow") continue;
      if (decision.action === "abort" || decision.action === "pause") return decision;

      const targetCallIds = decision.callIds?.length
        ? decision.callIds
        : invocations.map((invocation) => invocation.callId);
      for (const callId of targetCallIds) {
        denied.set(callId, decision.reason ?? "Tool execution denied.");
      }
    }

    return denied.size > 0
      ? { action: "deny", reason: "Some tool calls were denied.", callIds: [...denied.keys()] }
      : { action: "allow" };
  }

  private async executeAuthorizedTools(
    invocations: ReturnType<ToolRuntime["prepare"]>,
    authorization: AgentToolAuthorizationResult,
    profile: ResolvedRunProfile,
  ): Promise<AgentToolExecutionResult[]> {
    if (authorization.action !== "deny") {
      return this.toolRuntime.execute(invocations, profile);
    }

    const deniedCallIds = new Set(authorization.callIds ?? invocations.map((invocation) => invocation.callId));
    const allowed: typeof invocations = [];
    const resultByCallId = new Map<string, AgentToolExecutionResult>();

    for (const invocation of invocations) {
      if (deniedCallIds.has(invocation.callId)) {
        resultByCallId.set(
          invocation.callId,
          this.toolRuntime.deny(
            invocation.callId,
            invocation.tool.name,
            authorization.reason ?? "Tool execution denied.",
          ),
        );
      } else {
        allowed.push(invocation);
      }
    }

    const allowedResults = await this.toolRuntime.execute(allowed, profile);
    allowed.forEach((invocation, index) => {
      resultByCallId.set(invocation.callId, allowedResults[index]);
    });

    return invocations.map((invocation) => {
      const result = resultByCallId.get(invocation.callId);
      if (!result) {
        throw new Error(`Missing tool result for call ${invocation.callId}`);
      }
      return result;
    });
  }

  private async emitRunFinished(
    outcome: QueryModelOutcome,
    profile: ResolvedRunProfile,
  ): Promise<void> {
    await this.emitEvent({
      type: "run_finished",
      runId: this.runStateMachine.runId,
      finishReason: outcome.finishReason,
      llmRounds: outcome.llmRounds,
      stopped: outcome.stopped,
      stopReason: outcome.stopReason,
      error: outcome.error,
      labels: profile.labels,
      featureFlags: profile.featureFlags,
    });
  }

  private async emitEvent(event: AgentHookEvent): Promise<void> {
    for (const hook of this.enterpriseHooks) {
      await hook.onEvent?.(event);
    }
  }
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

function mergeProviderOptions(
  current?: Record<string, unknown>,
  patch?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!current && !patch) return undefined;
  if (!current) return patch ? { ...patch } : undefined;
  if (!patch) return { ...current };
  return { ...current, ...patch };
}
