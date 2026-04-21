import { randomUUID } from "node:crypto";
import type { LLMClient } from "@renx/provider";
import type { AgentHook } from "../agent/hooks";
import type { LlmRetryConfig, QueryModelHooks, QueryModelOutcome } from "../agent/types";
import type { AgentLogger } from "../agent/logger";
import { noopLogger } from "../agent/logger";
import type { QueryModelType } from "../domain/query-model";
import type { SandboxRegistry } from "../sandbox/sandbox-registry";
import type { ToolRegistry } from "../tools/registry";
import type { ContextBuilder } from "./context-builder";
import { DefaultContextBuilder } from "./context-builder";
import { Harness, type HarnessOutcome } from "./harness";
import type {
  AgentEventQuery,
  AgentRunLease,
  AgentRunQuery,
  AgentPendingApproval,
  AgentRunRecord,
  AgentRuntimeEvent,
  AgentSessionStore,
} from "./session-store";
import { InMemorySessionStore } from "./session-store";
import type { SummaryManager } from "./summary-manager";
import { DefaultSummaryManager } from "./summary-manager";
import type { AgentTelemetrySink } from "./telemetry";
import { noopTelemetry } from "./telemetry";
import type { TerminationPolicy } from "./termination-policy";
import { DefaultTerminationPolicy } from "./termination-policy";

export type ResumeRunInput = {
  userMessages?: QueryModelType["messages"];
  clearPendingApproval?: boolean;
};

export type AgentRuntimeConfig = {
  maxSteps: number;
  registry: ToolRegistry;
  sandboxRegistry: SandboxRegistry;
  hooks?: AgentHook[];
  llmRetry?: LlmRetryConfig;
  llmClient?: LLMClient;
  logger?: AgentLogger;
  sessionStore?: AgentSessionStore;
  terminationPolicy?: TerminationPolicy;
  contextBuilder?: ContextBuilder;
  summaryManager?: SummaryManager;
  telemetry?: AgentTelemetrySink;
};

function nowIso(): string {
  return new Date().toISOString();
}

export class AgentRuntime {
  private readonly logger: AgentLogger;
  private readonly sessionStore: AgentSessionStore;
  private readonly terminationPolicy: TerminationPolicy;
  private readonly contextBuilder: ContextBuilder;
  private readonly summaryManager: SummaryManager;
  private readonly telemetry: AgentTelemetrySink;

  constructor(private readonly config: AgentRuntimeConfig) {
    this.logger = config.logger ?? noopLogger;
    this.sessionStore = config.sessionStore ?? new InMemorySessionStore();
    this.terminationPolicy = config.terminationPolicy ?? new DefaultTerminationPolicy();
    this.contextBuilder = config.contextBuilder ?? new DefaultContextBuilder();
    this.summaryManager = config.summaryManager ?? new DefaultSummaryManager();
    this.telemetry = config.telemetry ?? noopTelemetry;
  }

  async createRun(initial: QueryModelType): Promise<AgentRunRecord> {
    const timestamp = nowIso();
    const run: AgentRunRecord = {
      runId: randomUUID(),
      status: "ready",
      maxSteps: this.config.maxSteps,
      llmRounds: 0,
      initial,
      messages: [...initial.messages],
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.sessionStore.createRun(run);
    await this.sessionStore.appendEvents(run.runId, [
      {
        type: "run_created",
        runId: run.runId,
        at: timestamp,
        model: initial.model,
        maxSteps: this.config.maxSteps,
      },
    ]);
    await this.captureTelemetry({
      name: "run_created",
      at: timestamp,
      runId: run.runId,
      status: run.status,
      metadata: { model: initial.model, maxSteps: this.config.maxSteps },
    });

    return run;
  }

  async run(initial: QueryModelType, hooks?: QueryModelHooks): Promise<QueryModelOutcome> {
    const run = await this.createRun(initial);
    return this.startRun(run.runId, hooks);
  }

  async startRun(runId: string, hooks?: QueryModelHooks): Promise<QueryModelOutcome> {
    const run = await this.requireRun(runId);
    if (run.status === "cancelled") {
      throw new Error(`Run ${runId} has been cancelled and cannot be started.`);
    }
    if (run.status === "finished" || run.status === "failed") {
      return this.outcomeFromRun(run, "stop");
    }

    const timestamp = nowIso();
    const nextRun: AgentRunRecord = {
      ...run,
      status: "running",
      startedAt: run.startedAt ?? timestamp,
      updatedAt: timestamp,
      pendingApproval: undefined,
      pendingInput: undefined,
    };

    await this.sessionStore.saveRun(nextRun);
    await this.sessionStore.appendEvents(runId, [
      {
        type: "run_started",
        runId,
        at: timestamp,
        resumed: run.status !== "ready",
        status: nextRun.status,
      },
    ]);
    await this.captureTelemetry({
      name: "run_started",
      at: timestamp,
      runId,
      status: nextRun.status,
      metadata: { resumed: run.status !== "ready" },
    });

    return this.executeRun(nextRun, hooks);
  }

  async resumeRun(runId: string, input: ResumeRunInput = {}, hooks?: QueryModelHooks): Promise<QueryModelOutcome> {
    const run = await this.requireRun(runId);
    if (run.status !== "waiting_input" && run.status !== "waiting_permission" && run.status !== "running") {
      throw new Error(`Run ${runId} is not resumable from status ${run.status}.`);
    }

    const events: AgentRuntimeEvent[] = [];
    const nextMessages = [...run.messages];
    if (input.userMessages?.length) {
      nextMessages.push(...input.userMessages);
      events.push({
        type: "user_input_appended",
        runId,
        at: nowIso(),
        messageCount: input.userMessages.length,
      });
    }

    const nextRun: AgentRunRecord = {
      ...run,
      status: "running",
      messages: nextMessages,
      pendingInput: undefined,
      pendingApproval: input.clearPendingApproval ? undefined : run.pendingApproval,
      updatedAt: nowIso(),
    };

    await this.sessionStore.saveRun(nextRun);
    if (events.length > 0) {
      await this.sessionStore.appendEvents(runId, events);
    }
    return this.startRun(runId, hooks);
  }

  async cancelRun(runId: string): Promise<AgentRunRecord> {
    const run = await this.requireRun(runId);
    if (run.status === "finished" || run.status === "failed" || run.status === "cancelled") {
      return run;
    }

    const timestamp = nowIso();
    const nextRun: AgentRunRecord = {
      ...run,
      status: "cancelled",
      stopReason: "cancelled",
      finishedAt: timestamp,
      updatedAt: timestamp,
    };
    await this.sessionStore.saveRun(nextRun);
    await this.sessionStore.appendEvents(runId, [
      {
        type: "run_finished",
        runId,
        at: timestamp,
        status: "cancelled",
        finishReason: "stop",
        stopReason: "cancelled",
      },
    ]);
    await this.captureTelemetry({
      name: "run_cancelled",
      at: timestamp,
      runId,
      status: nextRun.status,
      finishReason: "stop",
    });
    return nextRun;
  }

  async getRun(runId: string): Promise<AgentRunRecord | null> {
    return this.sessionStore.getRun(runId);
  }

  async listRuns(query?: AgentRunQuery): Promise<AgentRunRecord[]> {
    return this.sessionStore.listRuns(query);
  }

  async getRunTrace(runId: string, query?: AgentEventQuery): Promise<AgentRuntimeEvent[]> {
    return this.sessionStore.listEvents(runId, query);
  }

  async getRunLease(runId: string): Promise<AgentRunLease | null> {
    return this.sessionStore.getLease(runId);
  }

  async acquireRunLease(runId: string, ownerId: string, ttlMs: number): Promise<AgentRunLease | null> {
    const lease = await this.sessionStore.acquireLease(runId, ownerId, ttlMs);
    if (lease) {
      await this.captureTelemetry({
        name: "lease_acquired",
        at: nowIso(),
        runId,
        ownerId,
        metadata: { ttlMs },
      });
    }
    return lease;
  }

  async renewRunLease(runId: string, ownerId: string, ttlMs: number): Promise<AgentRunLease | null> {
    const lease = await this.sessionStore.renewLease(runId, ownerId, ttlMs);
    if (lease) {
      await this.captureTelemetry({
        name: "lease_renewed",
        at: nowIso(),
        runId,
        ownerId,
        metadata: { ttlMs },
      });
    }
    return lease;
  }

  async releaseRunLease(runId: string, ownerId: string): Promise<void> {
    await this.sessionStore.releaseLease(runId, ownerId);
    await this.captureTelemetry({
      name: "lease_released",
      at: nowIso(),
      runId,
      ownerId,
    });
  }

  private async executeRun(run: AgentRunRecord, hooks?: QueryModelHooks): Promise<QueryModelOutcome> {
    let liveRun = run;

    const persistRun = async (patch: Partial<AgentRunRecord>): Promise<void> => {
      liveRun = {
        ...liveRun,
        ...patch,
        updatedAt: nowIso(),
      };
      await this.sessionStore.saveRun(liveRun);
    };

    const harness = new Harness({
      maxSteps: this.config.maxSteps,
      registry: this.config.registry,
      sandboxRegistry: this.config.sandboxRegistry,
      hooks,
      enterpriseHooks: this.config.hooks,
      llmRetry: this.config.llmRetry,
      llmClient: this.config.llmClient,
      logger: this.logger,
      terminationPolicy: this.terminationPolicy,
      contextBuilder: this.contextBuilder,
      summaryManager: this.summaryManager,
      telemetry: this.telemetry,
      recordEvents: async (events) => {
        if (events.length > 0) {
          await this.sessionStore.appendEvents(liveRun.runId, events);
        }
      },
      persistRun,
    });

    try {
      const outcome = await harness.run(liveRun);
      const finalRun = this.applyOutcomeToRun(liveRun, outcome);
      await this.sessionStore.saveRun(finalRun);
      await this.sessionStore.appendEvents(finalRun.runId, this.finalEvents(finalRun, outcome));
      await this.captureTelemetry({
        name: outcome.status === "waiting_input" || outcome.status === "waiting_permission" ? "run_waiting" : "run_finished",
        at: nowIso(),
        runId: finalRun.runId,
        status: finalRun.status,
        finishReason: outcome.finishReason,
        metadata: outcome.stopReason ? { stopReason: outcome.stopReason } : undefined,
      });
      return outcome;
    } catch (error) {
      const timestamp = nowIso();
      const failedRun: AgentRunRecord = {
        ...liveRun,
        status: "failed",
        lastError: error,
        stopReason: "fatal_error",
        finishedAt: timestamp,
        updatedAt: timestamp,
      };
      await this.sessionStore.saveRun(failedRun);
      await this.sessionStore.appendEvents(failedRun.runId, [
        {
          type: "run_finished",
          runId: failedRun.runId,
          at: timestamp,
          status: "failed",
          finishReason: "error",
          stopReason: "fatal_error",
          error,
        },
      ]);
      await this.captureTelemetry({
        name: "run_finished",
        at: timestamp,
        runId: failedRun.runId,
        status: failedRun.status,
        finishReason: "error",
        metadata: { stopReason: "fatal_error" },
      });
      return {
        runId: failedRun.runId,
        status: failedRun.status,
        messages: [...failedRun.messages],
        summary: failedRun.summary,
        finishReason: "error",
        llmRounds: failedRun.llmRounds,
        lastStream: {
          ok: false,
          error,
          textStream: (async function* () {})(),
          text: Promise.resolve(""),
          reasoning: Promise.resolve(""),
          toolCalls: Promise.resolve([]),
          usage: Promise.resolve(undefined),
          finishReason: Promise.resolve("error"),
        },
        error,
        stopReason: failedRun.stopReason,
      };
    }
  }

  private applyOutcomeToRun(run: AgentRunRecord, outcome: HarnessOutcome): AgentRunRecord {
    const timestamp = nowIso();
    const terminal = outcome.status === "finished" || outcome.status === "failed";
    return {
      ...run,
      status: outcome.status,
      messages: outcome.messages,
      llmRounds: outcome.llmRounds,
      summary: outcome.summary,
      stopReason: outcome.stopReason,
      lastError: outcome.error,
      pendingApproval: outcome.pendingApproval,
      pendingInput: outcome.status === "waiting_input"
        ? { reason: outcome.stopReason ?? "Additional user input required.", requestedAt: timestamp }
        : undefined,
      updatedAt: timestamp,
      finishedAt: terminal ? timestamp : run.finishedAt,
    };
  }

  private finalEvents(run: AgentRunRecord, outcome: HarnessOutcome): AgentRuntimeEvent[] {
    const timestamp = nowIso();
    if (outcome.status === "waiting_permission") {
      return [
        {
          type: "run_waiting",
          runId: run.runId,
          at: timestamp,
          status: "waiting_permission",
          reason: outcome.stopReason,
          pendingApproval: outcome.pendingApproval,
        },
      ];
    }

    if (outcome.status === "waiting_input") {
      return [
        {
          type: "run_waiting",
          runId: run.runId,
          at: timestamp,
          status: "waiting_input",
          reason: outcome.stopReason,
          pendingInput: { reason: outcome.stopReason ?? "Additional user input required.", requestedAt: timestamp },
        },
      ];
    }

    return [
      {
        type: "run_finished",
        runId: run.runId,
        at: timestamp,
        status: outcome.status === "failed" ? "failed" : "finished",
        finishReason: outcome.finishReason,
        stopReason: outcome.stopReason,
        error: outcome.error,
      },
    ];
  }

  private outcomeFromRun(run: AgentRunRecord, finishReason: QueryModelOutcome["finishReason"]): QueryModelOutcome {
    return {
      runId: run.runId,
      status: run.status,
      messages: [...run.messages],
      summary: run.summary,
      finishReason,
      llmRounds: run.llmRounds,
      lastStream: {
        ok: false,
        error: run.lastError ?? new Error("Run is not actively executing."),
        textStream: (async function* () {})(),
        text: Promise.resolve(""),
        reasoning: Promise.resolve(""),
        toolCalls: Promise.resolve([]),
        usage: Promise.resolve(undefined),
        finishReason: Promise.resolve(finishReason),
      },
      error: run.lastError,
      stopReason: run.stopReason,
      pendingApproval: run.pendingApproval as AgentPendingApproval | undefined,
    };
  }

  private async requireRun(runId: string): Promise<AgentRunRecord> {
    const run = await this.sessionStore.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    return run;
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
