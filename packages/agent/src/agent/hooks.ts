import type { CanonicalFinishReason, CanonicalToolCall, CanonicalUsage } from "@renx/provider";
import type { Message } from "../domain/message";
import type { QueryModelType } from "../domain/query-model";
import type { AgentToolExecutionResult } from "../tools/type";

export type AgentFeatureFlagValue = boolean | string | number;

export type AgentRunProfilePatch = {
  labels?: Record<string, string>;
  featureFlags?: Record<string, AgentFeatureFlagValue>;
  traceId?: string;
  tenantId?: string;
  model?: QueryModelType["model"];
  providerOptions?: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  stopSequences?: string[];
  toolChoice?: QueryModelType["toolChoice"];
  suppressStreaming?: boolean;
  sandboxProfileId?: string;
  sandboxPolicy?: Record<string, unknown>;
};

export type ResolvedRunProfile = {
  labels: Record<string, string>;
  featureFlags: Record<string, AgentFeatureFlagValue>;
  traceId?: string;
  tenantId?: string;
  overrides: Pick<
    AgentRunProfilePatch,
    | "model"
    | "providerOptions"
    | "temperature"
    | "maxOutputTokens"
    | "topP"
    | "stopSequences"
    | "toolChoice"
  >;
  suppressStreaming: boolean;
  sandboxProfileId?: string;
  sandboxPolicy?: Record<string, unknown>;
};

export type AgentToolInvocation = {
  callId: string;
  name: string;
  args: Record<string, unknown>;
};

export type AgentToolAuthorizationResult =
  | { action: "allow" }
  | { action: "deny"; reason?: string; callIds?: string[] }
  | { action: "abort"; reason: string }
  | { action: "pause"; reason: string };

export type AgentRunStartContext = {
  runId: string;
  maxSteps: number;
  initial: QueryModelType;
  signal?: AbortSignal;
};

export type AgentToolAuthorizationContext = {
  runId: string;
  llmRound: number;
  messages: Message[];
  invocations: AgentToolInvocation[];
  labels: Record<string, string>;
  featureFlags: Record<string, AgentFeatureFlagValue>;
  signal?: AbortSignal;
};

export type AgentHookEvent =
  | {
      type: "run_started";
      runId: string;
      maxSteps: number;
      model: QueryModelType["model"];
      labels: Record<string, string>;
      featureFlags: Record<string, AgentFeatureFlagValue>;
    }
  | {
      type: "step_started";
      runId: string;
      llmRound: number;
      messageCount: number;
      labels: Record<string, string>;
      featureFlags: Record<string, AgentFeatureFlagValue>;
    }
  | {
      type: "model_started";
      runId: string;
      llmRound: number;
      model: QueryModelType["model"];
      toolCount: number;
      messageCount: number;
      labels: Record<string, string>;
      featureFlags: Record<string, AgentFeatureFlagValue>;
    }
  | {
      type: "model_completed";
      runId: string;
      llmRound: number;
      ok: boolean;
      finishReason: CanonicalFinishReason;
      assistantText: string;
      toolCalls: CanonicalToolCall[];
      usage?: CanonicalUsage;
      error?: unknown;
      labels: Record<string, string>;
      featureFlags: Record<string, AgentFeatureFlagValue>;
    }
  | {
      type: "tool_authorization_requested";
      runId: string;
      llmRound: number;
      invocations: AgentToolInvocation[];
      labels: Record<string, string>;
      featureFlags: Record<string, AgentFeatureFlagValue>;
    }
  | {
      type: "tool_authorization_resolved";
      runId: string;
      llmRound: number;
      action: AgentToolAuthorizationResult["action"];
      deniedCallIds?: string[];
      reason?: string;
      labels: Record<string, string>;
      featureFlags: Record<string, AgentFeatureFlagValue>;
    }
  | {
      type: "tool_completed";
      runId: string;
      llmRound: number;
      results: AgentToolExecutionResult[];
      labels: Record<string, string>;
      featureFlags: Record<string, AgentFeatureFlagValue>;
    }
  | {
      type: "run_finished";
      runId: string;
      finishReason: CanonicalFinishReason;
      llmRounds: number;
      stopped?: boolean;
      stopReason?: string;
      error?: unknown;
      labels: Record<string, string>;
      featureFlags: Record<string, AgentFeatureFlagValue>;
    };

export interface AgentHook {
  readonly name?: string;
  assignRunProfile?(ctx: AgentRunStartContext): Promise<AgentRunProfilePatch | void> | AgentRunProfilePatch | void;
  authorizeTools?(
    ctx: AgentToolAuthorizationContext,
  ): Promise<AgentToolAuthorizationResult | void> | AgentToolAuthorizationResult | void;
  onEvent?(event: AgentHookEvent): Promise<void> | void;
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

export function createDefaultRunProfile(): ResolvedRunProfile {
  return {
    labels: {},
    featureFlags: {},
    overrides: {},
    suppressStreaming: false,
  };
}

export function mergeRunProfile(
  current: ResolvedRunProfile,
  patch: AgentRunProfilePatch | void,
): ResolvedRunProfile {
  if (!patch) return current;

  return {
    labels: { ...current.labels, ...(patch.labels ?? {}) },
    featureFlags: { ...current.featureFlags, ...(patch.featureFlags ?? {}) },
    traceId: patch.traceId ?? current.traceId,
    tenantId: patch.tenantId ?? current.tenantId,
    overrides: {
      ...current.overrides,
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.temperature !== undefined ? { temperature: patch.temperature } : {}),
      ...(patch.maxOutputTokens !== undefined ? { maxOutputTokens: patch.maxOutputTokens } : {}),
      ...(patch.topP !== undefined ? { topP: patch.topP } : {}),
      ...(patch.stopSequences !== undefined ? { stopSequences: patch.stopSequences } : {}),
      ...(patch.toolChoice !== undefined ? { toolChoice: patch.toolChoice } : {}),
      providerOptions: mergeProviderOptions(current.overrides.providerOptions, patch.providerOptions),
    },
    suppressStreaming: patch.suppressStreaming ?? current.suppressStreaming,
    sandboxProfileId: patch.sandboxProfileId ?? current.sandboxProfileId,
    sandboxPolicy:
      patch.sandboxPolicy != null
        ? { ...current.sandboxPolicy, ...patch.sandboxPolicy }
        : current.sandboxPolicy,
  };
}

export type PermissionHookOptions = {
  toolsRequiringConfirmation?: string[];
  requiresConfirmation?: (name: string, args: Record<string, unknown>) => boolean;
  confirm: (req: { invocations: AgentToolInvocation[] }) => Promise<boolean>;
  onReject?: "deny" | "abort" | "pause";
  rejectReason?: string;
};

function needsConfirmation(
  invocation: AgentToolInvocation,
  options: PermissionHookOptions,
): boolean {
  const byList =
    options.toolsRequiringConfirmation != null &&
    options.toolsRequiringConfirmation.includes(invocation.name);
  const byFn = options.requiresConfirmation?.(invocation.name, invocation.args) === true;
  return byList || byFn;
}

export function createPermissionHook(options: PermissionHookOptions): AgentHook {
  const onReject = options.onReject ?? "deny";
  const rejectReason = options.rejectReason ?? "User did not approve this tool execution.";

  return {
    name: "permission",
    async authorizeTools(ctx) {
      const flagged = ctx.invocations.filter((invocation) => needsConfirmation(invocation, options));
      if (flagged.length === 0) {
        return { action: "allow" };
      }

      const approved = await options.confirm({ invocations: flagged });
      if (approved) {
        return { action: "allow" };
      }

      if (onReject === "abort") {
        return { action: "abort", reason: rejectReason };
      }
      if (onReject === "pause") {
        return { action: "pause", reason: rejectReason };
      }
      return {
        action: "deny",
        reason: rejectReason,
        callIds: flagged.map((invocation) => invocation.callId),
      };
    },
  };
}

export type AuditHookOptions = {
  sink: (event: AgentHookEvent) => Promise<void> | void;
  onError?: (error: unknown) => void;
};

export function createAuditHook(options: AuditHookOptions): AgentHook {
  return {
    name: "audit",
    async onEvent(event) {
      try {
        await options.sink(event);
      } catch (error) {
        options.onError?.(error);
      }
    },
  };
}

export type LoggingHookOptions = {
  logger?: Pick<Console, "debug" | "info" | "warn" | "error">;
};

export function createLoggingHook(options: LoggingHookOptions = {}): AgentHook {
  const logger = options.logger ?? console;

  return createAuditHook({
    sink(event) {
      if (event.type === "model_completed" && !event.ok) {
        logger.warn("[agent]", event);
        return;
      }
      if (event.type === "run_finished" && event.error) {
        logger.error("[agent]", event);
        return;
      }
      logger.info("[agent]", event);
    },
  });
}

export type ExperimentHookOptions = {
  assign: (
    ctx: AgentRunStartContext,
  ) => Promise<AgentRunProfilePatch | void> | AgentRunProfilePatch | void;
};

export function createExperimentHook(options: ExperimentHookOptions): AgentHook {
  return {
    name: "experiment",
    assignRunProfile(ctx) {
      return options.assign(ctx);
    },
  };
}
