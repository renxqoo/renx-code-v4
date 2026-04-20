import type { CanonicalTool } from "@renx/provider";
import type { LLMClient } from "@renx/provider";
import {
  createDefaultRunProfile,
  mergeRunProfile,
  type AgentHook,
  type AgentHookEvent,
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
import { runtime, type RuntimeOutcome } from "../model/runtime";
import { drainTextStream } from "../model/stream-drain";
import type { SandboxRegistry } from "../sandbox/sandbox-registry";
import { toolsToCanonical } from "../tools/canonical";
import type { ToolRegistry } from "../tools/registry";
import type { AgentToolExecutionResult } from "../tools/type";
import type { ContextBuilder } from "./context-builder";
import { DecisionRouter } from "./decision-router";
import type {
  AgentPendingApproval,
  AgentRunRecord,
  AgentRunSummary,
  AgentRuntimeEvent,
} from "./session-store";
import type { SummaryManager } from "./summary-manager";
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
  contextBuilder: ContextBuilder;
  summaryManager: SummaryManager;
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
  private readonly registry: ToolRegistry;
  private readonly hooks?: QueryModelHooks;
  private readonly enterpriseHooks: AgentHook[];
  private readonly llmRetry?: LlmRetryConfig;
  private readonly llmClient?: LLMClient;
  private readonly logger: AgentLogger;
  private readonly terminationPolicy: TerminationPolicy;
  private readonly decisionRouter = new DecisionRouter();
  private readonly toolRuntime: ToolRuntime;
  private readonly contextBuilder: ContextBuilder;
  private readonly summaryManager: SummaryManager;
  private readonly recordEvents?: (events: AgentRuntimeEvent[]) => Promise<void>;
  private readonly persistRun?: (patch: Partial<AgentRunRecord>) => Promise<void>;

  constructor(deps: HarnessDependencies) {
    this.maxSteps = deps.maxSteps;
    this.registry = deps.registry;
    this.hooks = deps.hooks;
    this.enterpriseHooks = deps.enterpriseHooks ?? [];
    this.llmRetry = deps.llmRetry;
    this.llmClient = deps.llmClient;
    this.logger = deps.logger ?? noopLogger;
    this.terminationPolicy = deps.terminationPolicy;
    this.toolRuntime = new ToolRuntime(deps.registry, deps.sandboxRegistry, this.logger);
    this.contextBuilder = deps.contextBuilder;
    this.summaryManager = deps.summaryManager;
    this.recordEvents = deps.recordEvents;
    this.persistRun = deps.persistRun;
  }

  async run(run: AgentRunRecord): Promise<HarnessOutcome> {
    const state = initLoopState(run, this.llmRetry);
    state.profile = await this.resolveRunProfile(run);

    while (true) {
      if (state.llmRounds >= this.maxSteps) {
        const finishReason = await state.lastStream.finishReason;
        return {
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
      }

      state.llmRounds++;
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

      let outcome: RuntimeOutcome;
      let finishReason: Awaited<RuntimeOutcome["finishReason"]>;
      let assistantText: string;
      let calls: Awaited<RuntimeOutcome["toolCalls"]>;
      let usage: Awaited<RuntimeOutcome["usage"]>;

      modelAttemptLoop: while (true) {
        const tools = mergeCanonicalTools(toolsToCanonical(this.registry.list()), run.initial.tools);
        const streamConfig = await this.contextBuilder.build({
          run: {
            ...run,
            messages: state.messages,
            llmRounds: state.llmRounds,
            summary: state.summary,
          },
          profile: state.profile,
          tools,
        });

        this.logger.debug("modelCall", {
          runId: run.runId,
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

        await this.pushEvents([
          {
            type: "model_completed",
            runId: run.runId,
            at: new Date().toISOString(),
            stepIndex: state.llmRounds,
            llmRound: state.llmRounds,
            ok: outcome.ok,
            finishReason,
            assistantText,
            toolCalls: calls,
            usage,
            error: outcome.ok ? undefined : outcome.error,
          },
        ]);

        if (outcome.ok) break modelAttemptLoop;

        this.logger.warn("modelCallFailed", {
          runId: run.runId,
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
        return {
          runId: run.runId,
          status: "failed",
          messages: state.messages,
          summary: state.summary,
          finishReason: "error",
          llmRounds: state.llmRounds,
          lastStream: outcome,
          error: decision.error,
          stopReason: "model_error",
        };
      }

      if (decision.type === "final_answer") {
        state.messages = appendAssistantTextOnly(state.messages, decision.assistantText);
        await this.refreshSummary(run, state);
        await this.persistProgress(run, state);
        return {
          runId: run.runId,
          status: "finished",
          messages: state.messages,
          summary: state.summary,
          finishReason: decision.finishReason,
          llmRounds: state.llmRounds,
          lastStream: outcome,
        };
      }

      state.messages = appendAssistantToolRound(state.messages, decision.assistantText, decision.toolCalls);
      const invocations = this.toolRuntime.prepare(decision.toolCalls);
      const hookInvocations: AgentToolInvocation[] = invocations.map((invocation) => ({
        callId: invocation.callId,
        name: invocation.tool.name,
        args: invocation.args,
      }));

      const authorization = await this.authorizeTools(state, run, hookInvocations);

      if (authorization.action === "abort") {
        return {
          runId: run.runId,
          status: "failed",
          messages: state.messages,
          summary: state.summary,
          finishReason: "stop",
          llmRounds: state.llmRounds,
          lastStream: state.lastStream,
          error: new Error(authorization.reason),
          stopReason: authorization.reason,
        };
      }

      if (authorization.action === "pause") {
        const pendingApproval: AgentPendingApproval = {
          invocations: hookInvocations,
          reason: authorization.reason,
          requestedAt: new Date().toISOString(),
        };
        return {
          runId: run.runId,
          status: "waiting_permission",
          messages: state.messages,
          summary: state.summary,
          finishReason: "stop",
          llmRounds: state.llmRounds,
          lastStream: state.lastStream,
          stopReason: authorization.reason,
          pendingApproval,
        };
      }

      const results = await this.executeAuthorizedTools(invocations, authorization, state.profile);
      state.messages = appendToolResultMessages(state.messages, decision.toolCalls, results);

      await this.pushEvents([
        {
          type: "tool_execution_completed",
          runId: run.runId,
          at: new Date().toISOString(),
          stepIndex: state.llmRounds,
          llmRound: state.llmRounds,
          toolCalls: decision.toolCalls,
          results: results.map((result) => ({
            success: result.success,
            content: result.content,
            metadata: result.metadata,
          })),
        },
      ]);

      await this.refreshSummary(run, state);
      await this.persistProgress(run, state);

      if (termination.shouldStop) {
        return {
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

  private async authorizeTools(
    state: LoopState,
    run: AgentRunRecord,
    invocations: AgentToolInvocation[],
  ): Promise<AgentToolAuthorizationResult> {
    const denied = new Map<string, string>();

    for (const hook of this.enterpriseHooks) {
      const decision = await hook.authorizeTools?.({
        runId: run.runId,
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

  private async pushEvents(events: AgentRuntimeEvent[]): Promise<void> {
    await this.recordEvents?.(events);
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
