import { randomUUID } from "node:crypto";
import type { QueryModelHooks } from "../agent/types";
import type { AgentLogger } from "../agent/logger";
import { noopLogger } from "../agent/logger";
import type { AgentRunQuery, AgentRunRecord, AgentRunStatus } from "./session-store";
import type { AgentTelemetryEvent, AgentTelemetrySink } from "./telemetry";
import { noopTelemetry } from "./telemetry";
import { AgentRuntime, type ResumeRunInput } from "./agent-runtime";

export type AgentWorkerDecision =
  | { action: "start" }
  | { action: "resume"; input?: ResumeRunInput }
  | { action: "skip"; reason?: string };

export type AgentWorkerConfig = {
  runtime: AgentRuntime;
  ownerId?: string;
  pollIntervalMs?: number;
  leaseTtlMs?: number;
  leaseRenewIntervalMs?: number;
  batchSize?: number;
  statuses?: AgentRunStatus[];
  hooks?: QueryModelHooks;
  logger?: AgentLogger;
  telemetry?: AgentTelemetrySink;
  decide?: (run: AgentRunRecord) => AgentWorkerDecision | Promise<AgentWorkerDecision>;
};

const DEFAULT_STATUSES: AgentRunStatus[] = ["ready", "running"];

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new Error("Worker aborted"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class AgentWorker {
  readonly ownerId: string;
  private readonly runtime: AgentRuntime;
  private readonly pollIntervalMs: number;
  private readonly leaseTtlMs: number;
  private readonly leaseRenewIntervalMs: number;
  private readonly batchSize: number;
  private readonly statuses: AgentRunStatus[];
  private readonly hooks?: QueryModelHooks;
  private readonly logger: AgentLogger;
  private readonly telemetry: AgentTelemetrySink;
  private readonly decide: NonNullable<AgentWorkerConfig["decide"]>;

  constructor(config: AgentWorkerConfig) {
    this.runtime = config.runtime;
    this.ownerId = config.ownerId ?? randomUUID();
    this.pollIntervalMs = Math.max(0, config.pollIntervalMs ?? 250);
    this.leaseTtlMs = Math.max(1, config.leaseTtlMs ?? 30_000);
    this.leaseRenewIntervalMs = Math.max(1, config.leaseRenewIntervalMs ?? Math.max(1_000, Math.floor(this.leaseTtlMs / 2)));
    this.batchSize = Math.max(1, config.batchSize ?? 20);
    this.statuses = config.statuses?.length ? [...config.statuses] : DEFAULT_STATUSES;
    this.hooks = config.hooks;
    this.logger = config.logger ?? noopLogger;
    this.telemetry = config.telemetry ?? noopTelemetry;
    this.decide =
      config.decide ??
      ((run) => {
        if (run.status === "ready") return { action: "start" };
        if (run.status === "running") return { action: "resume", input: {} };
        return { action: "skip", reason: `Unsupported status ${run.status}` };
      });
  }

  async runLoop(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      const processed = await this.runOnce();
      await this.captureTelemetry({
        name: "worker_cycle",
        at: new Date().toISOString(),
        ownerId: this.ownerId,
        success: true,
        metadata: { processed },
      });
      if (processed === 0) {
        try {
          await delay(this.pollIntervalMs, signal);
        } catch {
          return;
        }
      }
    }
  }

  async runOnce(query?: Partial<AgentRunQuery>): Promise<number> {
    const runs = await this.runtime.listRuns({
      statuses: query?.statuses ?? this.statuses,
      offset: query?.offset,
      limit: query?.limit ?? this.batchSize,
    });
    let processed = 0;
    for (const run of runs) {
      const done = await this.processRun(run.runId);
      if (done) {
        processed += 1;
      }
    }
    return processed;
  }

  async processRun(runId: string): Promise<boolean> {
    const lease = await this.runtime.acquireRunLease(runId, this.ownerId, this.leaseTtlMs);
    if (!lease) {
      return false;
    }

    let renewTimer: ReturnType<typeof setInterval> | undefined;
    try {
      const run = await this.runtime.getRun(runId);
      if (!run) {
        return false;
      }
      if (run.status === "finished" || run.status === "failed" || run.status === "cancelled") {
        return false;
      }

      const decision = await this.decide(run);
      if (decision.action === "skip") {
        return false;
      }

      renewTimer = setInterval(() => {
        void this.runtime.renewRunLease(runId, this.ownerId, this.leaseTtlMs).catch((error) => {
          this.logger.warn("agentWorkerLeaseRenewFailed", {
            runId,
            ownerId: this.ownerId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, this.leaseRenewIntervalMs);

      if (decision.action === "start") {
        await this.runtime.startRun(runId, this.hooks);
      } else {
        await this.runtime.resumeRun(runId, decision.input ?? {}, this.hooks);
      }
      return true;
    } catch (error) {
      await this.captureTelemetry({
        name: "worker_error",
        at: new Date().toISOString(),
        runId,
        ownerId: this.ownerId,
        success: false,
        metadata: { error: error instanceof Error ? error.message : String(error) },
      });
      this.logger.error("agentWorkerRunFailed", {
        runId,
        ownerId: this.ownerId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      if (renewTimer !== undefined) {
        clearInterval(renewTimer);
      }
      await this.runtime.releaseRunLease(runId, this.ownerId);
    }
  }

  private async captureTelemetry(event: AgentTelemetryEvent): Promise<void> {
    try {
      await this.telemetry.capture(event);
    } catch (error) {
      this.logger.warn("agentWorkerTelemetryFailed", {
        eventName: event.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
