import { randomUUID } from "node:crypto";
import type { QueryModelOutcome } from "../agent/types";
import type { QueryModelType } from "../domain/query-model";
import type {
  AgentPendingInput,
  AgentRunRecord,
  AgentRuntimeEvent,
} from "./session-store";
import type { AgentTelemetryEvent } from "./telemetry";

export type ResumeRunTransitionInput = {
  userMessages?: QueryModelType["messages"];
  clearPendingApproval?: boolean;
};

export type RunTransition = {
  run: AgentRunRecord;
  events: AgentRuntimeEvent[];
  telemetry: AgentTelemetryEvent[];
};

export type RunStateMachineOptions = {
  now?: () => string;
  createRunId?: () => string;
};

function defaultNowIso(): string {
  return new Date().toISOString();
}

export class RunStateMachine {
  private readonly now: () => string;
  private readonly createRunId: () => string;

  constructor(options: RunStateMachineOptions = {}) {
    this.now = options.now ?? defaultNowIso;
    this.createRunId = options.createRunId ?? randomUUID;
  }

  create(initial: QueryModelType, maxSteps: number): RunTransition {
    const timestamp = this.now();
    const run: AgentRunRecord = {
      runId: this.createRunId(),
      status: "ready",
      maxSteps,
      llmRounds: 0,
      initial,
      messages: [...initial.messages],
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    return {
      run,
      events: [
        {
          type: "run_created",
          runId: run.runId,
          at: timestamp,
          model: initial.model,
          maxSteps,
        },
      ],
      telemetry: [
        {
          name: "run_created",
          at: timestamp,
          runId: run.runId,
          status: run.status,
          metadata: { model: initial.model, maxSteps },
        },
      ],
    };
  }

  start(run: AgentRunRecord): RunTransition {
    if (run.status === "waiting_input" || run.status === "waiting_permission") {
      throw new Error(`Run ${run.runId} is waiting and must be resumed via resumeRun().`);
    }
    if (run.status === "cancelled") {
      throw new Error(`Run ${run.runId} has been cancelled and cannot be started.`);
    }
    if (run.status !== "ready" && run.status !== "running") {
      throw new Error(`Run ${run.runId} is not startable from status ${run.status}.`);
    }

    return this.transitionToRunning(run, {
      resumed: run.status !== "ready",
      messages: run.messages,
      pendingApproval: undefined,
    });
  }

  resume(run: AgentRunRecord, input: ResumeRunTransitionInput = {}): RunTransition {
    if (run.status !== "waiting_input" && run.status !== "waiting_permission" && run.status !== "running") {
      throw new Error(`Run ${run.runId} is not resumable from status ${run.status}.`);
    }

    const nextMessages = [...run.messages];
    const events: AgentRuntimeEvent[] = [];
    if (input.userMessages?.length) {
      nextMessages.push(...input.userMessages);
      events.push({
        type: "user_input_appended",
        runId: run.runId,
        at: this.now(),
        messageCount: input.userMessages.length,
      });
    }

    const transition = this.transitionToRunning(run, {
      resumed: true,
      messages: nextMessages,
      pendingApproval: input.clearPendingApproval ? undefined : run.pendingApproval,
    });

    return {
      run: transition.run,
      events: [...events, ...transition.events],
      telemetry: transition.telemetry,
    };
  }

  cancel(run: AgentRunRecord): RunTransition {
    const timestamp = this.now();
    const nextRun: AgentRunRecord = {
      ...run,
      status: "cancelled",
      stopReason: "cancelled",
      finishedAt: timestamp,
      updatedAt: timestamp,
      pendingApproval: undefined,
      pendingInput: undefined,
    };

    return {
      run: nextRun,
      events: [
        {
          type: "run_finished",
          runId: run.runId,
          at: timestamp,
          status: "cancelled",
          finishReason: "stop",
          stopReason: "cancelled",
        },
      ],
      telemetry: [
        {
          name: "run_cancelled",
          at: timestamp,
          runId: run.runId,
          status: nextRun.status,
          finishReason: "stop",
        },
      ],
    };
  }

  complete(run: AgentRunRecord, outcome: QueryModelOutcome): RunTransition {
    const timestamp = this.now();
    const pendingInput: AgentPendingInput | undefined =
      outcome.status === "waiting_input"
        ? {
            reason: outcome.stopReason ?? "Additional user input required.",
            requestedAt: timestamp,
          }
        : undefined;
    const terminal = outcome.status === "finished" || outcome.status === "failed";
    const nextRun: AgentRunRecord = {
      ...run,
      status: outcome.status,
      messages: outcome.messages,
      llmRounds: outcome.llmRounds,
      summary: outcome.summary,
      stopReason: outcome.stopReason,
      lastError: outcome.error,
      pendingApproval: outcome.pendingApproval,
      pendingInput,
      updatedAt: timestamp,
      finishedAt: terminal ? timestamp : run.finishedAt,
    };

    return {
      run: nextRun,
      events: this.finalEvents(nextRun, outcome, pendingInput, timestamp),
      telemetry: [
        {
          name:
            outcome.status === "waiting_input" || outcome.status === "waiting_permission"
              ? "run_waiting"
              : "run_finished",
          at: timestamp,
          runId: nextRun.runId,
          status: nextRun.status,
          finishReason: outcome.finishReason,
          metadata: outcome.stopReason ? { stopReason: outcome.stopReason } : undefined,
        },
      ],
    };
  }

  fail(run: AgentRunRecord, error: unknown): RunTransition {
    const timestamp = this.now();
    const failedRun: AgentRunRecord = {
      ...run,
      status: "failed",
      lastError: error,
      stopReason: "fatal_error",
      finishedAt: timestamp,
      updatedAt: timestamp,
      pendingApproval: undefined,
      pendingInput: undefined,
    };

    return {
      run: failedRun,
      events: [
        {
          type: "run_finished",
          runId: failedRun.runId,
          at: timestamp,
          status: "failed",
          finishReason: "error",
          stopReason: "fatal_error",
          error,
        },
      ],
      telemetry: [
        {
          name: "run_finished",
          at: timestamp,
          runId: failedRun.runId,
          status: failedRun.status,
          finishReason: "error",
          metadata: { stopReason: "fatal_error" },
        },
      ],
    };
  }

  private transitionToRunning(
    run: AgentRunRecord,
    options: {
      resumed: boolean;
      messages: AgentRunRecord["messages"];
      pendingApproval: AgentRunRecord["pendingApproval"];
    },
  ): RunTransition {
    const timestamp = this.now();
    const nextRun: AgentRunRecord = {
      ...run,
      status: "running",
      messages: options.messages,
      startedAt: run.startedAt ?? timestamp,
      updatedAt: timestamp,
      pendingApproval: options.pendingApproval,
      pendingInput: undefined,
    };

    return {
      run: nextRun,
      events: [
        {
          type: "run_started",
          runId: run.runId,
          at: timestamp,
          resumed: options.resumed,
          status: nextRun.status,
        },
      ],
      telemetry: [
        {
          name: "run_started",
          at: timestamp,
          runId: run.runId,
          status: nextRun.status,
          metadata: { resumed: options.resumed },
        },
      ],
    };
  }

  private finalEvents(
    run: AgentRunRecord,
    outcome: QueryModelOutcome,
    pendingInput: AgentPendingInput | undefined,
    timestamp: string,
  ): AgentRuntimeEvent[] {
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
          pendingInput,
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
}
