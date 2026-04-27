import type { AgentHook, AgentHookEvent, AgentToolAuthorizationResult, AgentToolInvocation, ResolvedRunProfile } from "../agent/hooks";
import {
  appendAssistantToolRound,
  appendToolResultMessages,
} from "../conversation/tool-messages";
import type { Message } from "../domain/message";
import type { RuntimeOutcome } from "../model/runtime";
import type { AgentPendingApproval, AgentRunRecord, AgentRuntimeEvent } from "./session-store";
import type { AgentTelemetryEvent } from "./telemetry";
import { ToolRuntime, type PreparedToolInvocation } from "./tool-runtime";
import type { AgentDecision } from "./decision-router";
import type { AgentToolExecutionResult } from "../tools/type";

type ToolDecision = Extract<AgentDecision, { type: "tool_calls" }>;

export type ToolCallProcessorDependencies = {
  toolRuntime: ToolRuntime;
  enterpriseHooks: AgentHook[];
  emitEvent?: (event: AgentHookEvent) => Promise<void>;
  pushEvents?: (events: AgentRuntimeEvent[]) => Promise<void>;
  captureTelemetry?: (event: AgentTelemetryEvent) => Promise<void>;
};

export type ToolCallProcessorInput = {
  run: AgentRunRecord;
  llmRound: number;
  decision: ToolDecision;
  messages: Message[];
  profile: ResolvedRunProfile;
  signal?: AbortSignal;
};

export type ToolCallProcessorResult =
  | {
      type: "continue";
      messages: Message[];
      results: AgentToolExecutionResult[];
    }
  | {
      type: "abort";
      reason: string;
      messages: Message[];
    }
  | {
      type: "pause";
      reason: string;
      messages: Message[];
      pendingApproval: AgentPendingApproval;
    };

export class ToolCallProcessor {
  private readonly toolRuntime: ToolRuntime;
  private readonly enterpriseHooks: AgentHook[];
  private readonly emitEvent?: (event: AgentHookEvent) => Promise<void>;
  private readonly pushEvents?: (events: AgentRuntimeEvent[]) => Promise<void>;
  private readonly captureTelemetry?: (event: AgentTelemetryEvent) => Promise<void>;

  constructor(deps: ToolCallProcessorDependencies) {
    this.toolRuntime = deps.toolRuntime;
    this.enterpriseHooks = deps.enterpriseHooks;
    this.emitEvent = deps.emitEvent;
    this.pushEvents = deps.pushEvents;
    this.captureTelemetry = deps.captureTelemetry;
  }

  async process(input: ToolCallProcessorInput): Promise<ToolCallProcessorResult> {
    const nextMessages = appendAssistantToolRound(
      input.messages,
      input.decision.assistantText,
      input.decision.toolCalls,
    );
    const invocations = this.toolRuntime.prepare(input.decision.toolCalls);
    const hookInvocations = invocations.map<AgentToolInvocation>((invocation) => ({
      callId: invocation.callId,
      name: invocation.tool.name,
      args: invocation.args,
    }));

    await this.emitEvent?.({
      type: "tool_authorization_requested",
      runId: input.run.runId,
      llmRound: input.llmRound,
      invocations: hookInvocations,
      ...hookContext(input.profile),
    });

    const authorization = await this.authorizeTools({
      runId: input.run.runId,
      llmRound: input.llmRound,
      messages: nextMessages,
      invocations: hookInvocations,
      profile: input.profile,
      signal: input.signal,
    });

    await this.emitEvent?.({
      type: "tool_authorization_resolved",
      runId: input.run.runId,
      llmRound: input.llmRound,
      action: authorization.action,
      deniedCallIds: authorization.action === "deny" ? authorization.callIds : undefined,
      reason: "reason" in authorization ? authorization.reason : undefined,
      ...hookContext(input.profile),
    });

    if (authorization.action === "abort") {
      return {
        type: "abort",
        reason: authorization.reason,
        messages: nextMessages,
      };
    }

    if (authorization.action === "pause") {
      return {
        type: "pause",
        reason: authorization.reason,
        messages: nextMessages,
        pendingApproval: {
          invocations: hookInvocations,
          reason: authorization.reason,
          requestedAt: new Date().toISOString(),
        },
      };
    }

    const startedAt = Date.now();
    const results = await this.executeAuthorizedTools(invocations, authorization, input.profile);
    const finalMessages = appendToolResultMessages(nextMessages, input.decision.toolCalls, results);

    await this.emitEvent?.({
      type: "tool_completed",
      runId: input.run.runId,
      llmRound: input.llmRound,
      results,
      ...hookContext(input.profile),
    });

    await this.captureTelemetry?.({
      name: "tool_completed",
      at: new Date().toISOString(),
      runId: input.run.runId,
      llmRound: input.llmRound,
      durationMs: Date.now() - startedAt,
      toolCount: results.length,
      success: results.every((result) => result.success),
      metadata: {
        tools: input.decision.toolCalls.map((toolCall) => toolCall.name),
      },
    });

    await this.pushEvents?.([
      {
        type: "tool_execution_completed",
        runId: input.run.runId,
        at: new Date().toISOString(),
        stepIndex: input.llmRound,
        llmRound: input.llmRound,
        toolCalls: input.decision.toolCalls,
        results: results.map((result) => ({
          success: result.success,
          content: result.content,
          metadata: result.metadata,
        })),
      },
    ]);

    return {
      type: "continue",
      messages: finalMessages,
      results,
    };
  }

  private async authorizeTools(input: {
    runId: string;
    llmRound: number;
    messages: Message[];
    invocations: AgentToolInvocation[];
    profile: ResolvedRunProfile;
    signal?: AbortSignal;
  }): Promise<AgentToolAuthorizationResult> {
    const denied = new Map<string, string>();

    for (const hook of this.enterpriseHooks) {
      const decision = await hook.authorizeTools?.({
        runId: input.runId,
        llmRound: input.llmRound,
        messages: input.messages,
        invocations: input.invocations,
        labels: input.profile.labels,
        featureFlags: input.profile.featureFlags,
        signal: input.signal,
      });
      if (!decision || decision.action === "allow") continue;
      if (decision.action === "abort" || decision.action === "pause") {
        return decision;
      }

      const targetCallIds = decision.callIds?.length
        ? decision.callIds
        : input.invocations.map((invocation) => invocation.callId);
      for (const callId of targetCallIds) {
        denied.set(callId, decision.reason ?? "Tool execution denied.");
      }
    }

    return denied.size > 0
      ? { action: "deny", reason: "Some tool calls were denied.", callIds: [...denied.keys()] }
      : { action: "allow" };
  }

  private async executeAuthorizedTools(
    invocations: PreparedToolInvocation[],
    authorization: AgentToolAuthorizationResult,
    profile: ResolvedRunProfile,
  ): Promise<AgentToolExecutionResult[]> {
    if (authorization.action !== "deny") {
      return this.toolRuntime.execute(invocations, profile);
    }

    const deniedCallIds = new Set(authorization.callIds ?? invocations.map((invocation) => invocation.callId));
    const allowed: PreparedToolInvocation[] = [];
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
