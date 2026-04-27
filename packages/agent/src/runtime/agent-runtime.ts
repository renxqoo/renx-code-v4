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
import { Harness } from "./harness";
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
import { RunStateMachine } from "./run-state-machine";
import type { SummaryManager } from "./summary-manager";
import { DefaultSummaryManager } from "./summary-manager";
import type { AgentTelemetryEvent, AgentTelemetrySink } from "./telemetry";
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
  private readonly stateMachine = new RunStateMachine({ now: nowIso });

  constructor(private readonly config: AgentRuntimeConfig) {
    this.logger = config.logger ?? noopLogger;
    this.sessionStore = config.sessionStore ?? new InMemorySessionStore();
    this.terminationPolicy = config.terminationPolicy ?? new DefaultTerminationPolicy();
    this.contextBuilder = config.contextBuilder ?? new DefaultContextBuilder();
    this.summaryManager = config.summaryManager ?? new DefaultSummaryManager();
    this.telemetry = config.telemetry ?? noopTelemetry;
  }

  async createRun(initial: QueryModelType): Promise<AgentRunRecord> {
    return this.persistTransition(this.stateMachine.create(initial, this.config.maxSteps), "create");
  }

  async run(initial: QueryModelType, hooks?: QueryModelHooks): Promise<QueryModelOutcome> {
    const run = await this.createRun(initial);
    return this.startRun(run.runId, hooks);
  }

  async startRun(runId: string, hooks?: QueryModelHooks): Promise<QueryModelOutcome> {
    const run = await this.requireRun(runId);
    if (run.status === "finished" || run.status === "failed") {
      return this.outcomeFromRun(run, "stop");
    }
    if (run.status === "waiting_input") {
      return this.resumeRun(runId, {}, hooks);
    }
    if (run.status === "waiting_permission") {
      return this.resumeRun(runId, { clearPendingApproval: true }, hooks);
    }
    const nextRun = await this.persistTransition(this.stateMachine.start(run));
    return this.executeRun(nextRun, hooks);
  }

  async resumeRun(runId: string, input: ResumeRunInput = {}, hooks?: QueryModelHooks): Promise<QueryModelOutcome> {
    const run = await this.requireRun(runId);
    const nextRun = await this.persistTransition(this.stateMachine.resume(run, input));
    return this.executeRun(nextRun, hooks);
  }

  async cancelRun(runId: string): Promise<AgentRunRecord> {
    const run = await this.requireRun(runId);
    if (run.status === "finished" || run.status === "failed" || run.status === "cancelled") {
      return run;
    }
    return this.persistTransition(this.stateMachine.cancel(run));
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
      await this.persistTransition(this.stateMachine.complete(liveRun, outcome));
      return outcome;
    } catch (error) {
      const failedRun = await this.persistTransition(this.stateMachine.fail(liveRun, error));
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

  private async persistTransition(
    transition: {
      run: AgentRunRecord;
      events: AgentRuntimeEvent[];
      telemetry: AgentTelemetryEvent[];
    },
    mode: "create" | "save" = "save",
  ): Promise<AgentRunRecord> {
    if (mode === "create") {
      await this.sessionStore.createRun(transition.run);
    } else {
      await this.sessionStore.saveRun(transition.run);
    }
    if (transition.events.length > 0) {
      await this.sessionStore.appendEvents(transition.run.runId, transition.events);
    }
    for (const event of transition.telemetry) {
      await this.captureTelemetry(event);
    }
    return transition.run;
  }

  private async captureTelemetry(event: AgentTelemetryEvent): Promise<void> {
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
