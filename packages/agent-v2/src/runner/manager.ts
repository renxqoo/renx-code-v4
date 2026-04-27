import type { AgentInput, AgentGenerator, AgentFn } from "../types.js";
import type { RunState, RunStatus } from "../state.js";
import type { AgentEvent } from "../events.js";
import type { Message } from "../message.js";
import type { PersistenceAdapter } from "./adapters/adapter.js";
import { InMemoryAdapter } from "./adapters/memory.js";
import { initState } from "../state.js";
import { generateId } from "../utils/id.js";
import { createAgentError } from "../errors.js";

/**
 * Managed run — created by RunManager.create() or RunManager.resume().
 *
 * Lazy start: the agent is not invoked until stream() is called.
 * Multiple stream() calls return new generators, supporting pause/resume.
 *
 * per DESIGN.md §6.1
 */
export interface ManagedRun {
  readonly runId: string;

  /** Current run status */
  status(): RunState["status"];

  /** Full run state */
  state(): RunState;

  /** Stream agent events. Creates a new async generator each call. */
  stream(): AgentGenerator;

  /** Approve paused tool calls */
  approve(callIds: string[]): Promise<void>;

  /** Deny paused tool calls */
  deny(callIds: string[]): Promise<void>;

  /** Provide input when paused for input */
  provideInput(messages: Message[]): Promise<void>;

  /** Cancel the run */
  cancel(): Promise<void>;

  /** Get all persisted events for this run */
  events(): Promise<AgentEvent[]>;
}

/**
 * RunManager — creates, resumes, and manages agent runs with persistence.
 *
 * State machine:
 *   ready -> running via stream()
 *   running -> waiting_approval (on pause:approval)
 *   running -> waiting_input (on pause:input)
 *   running -> completed (on run:finished)
 *   running -> failed (on run:finished with error)
 *   waiting_approval -> running (on approve/deny)
 *   waiting_input -> running (on provideInput)
 *
 * per DESIGN.md §6.1, §8
 */
class RunManagerImpl {
  private adapter: PersistenceAdapter;
  private agentFn: AgentFn;
  private activeStreams = new Map<string, { controller: AbortController; gen: AgentGenerator | null }>();

  constructor(opts: { adapter?: PersistenceAdapter; agent: AgentFn }) {
    this.adapter = opts.adapter ?? new InMemoryAdapter();
    this.agentFn = opts.agent;
  }

  /**
   * Create a new managed run. Does NOT start the agent — lazy start on stream().
   */
  create(
    input: AgentInput,
  ): ManagedRun {
    const runId = input.runId ?? generateId();
    const state = initState({
      runId,
      model: input.model,
      systemPrompt: input.systemPrompt,
      messages: input.messages,
      workingMemory: input.workingMemory,
    });
    // Set initial status to "ready" (not "running")
    const readyState: RunState = { ...state, status: "ready" };
    this.adapter.saveState(readyState);
    this.setCachedState(readyState);

    return this.buildManagedRun(runId, input);
  }

  /**
   * Resume an existing run from persistence.
   */
  async resume(
    runId: string,
  ): Promise<ManagedRun> {
    const state = await this.adapter.loadState(runId);
    if (!state) {
      throw createAgentError(
        "INVALID_STATE",
        `Run not found: ${runId}`,
        false,
      );
    }

    // Reconstruct AgentInput from state
    const input: AgentInput = {
      runId: state.runId,
      model: state.model,
      systemPrompt: state.systemPrompt,
      messages: state.messages,
      workingMemory: state.workingMemory,
      maxSteps: state.stepCount + 10, // Allow more steps on resume
    };

    return this.buildManagedRun(runId, input);
  }

  /**
   * List runs, optionally filtered by status.
   */
  async list(
    filter?: { status?: RunStatus },
  ): Promise<ManagedRun[]> {
    const states = await this.adapter.listRuns(filter);
    return states.map((s) => {
      const input: AgentInput = {
        runId: s.runId,
        model: s.model,
        systemPrompt: s.systemPrompt,
        messages: s.messages,
      };
      return this.buildManagedRun(s.runId, input);
    });
  }

  private buildManagedRun(runId: string, input: AgentInput): ManagedRun {
    const self = this;

    return {
      runId,

      status(): RunStatus {
        const state = self.getCachedState(runId);
        return state?.status ?? "ready";
      },

      state(): RunState {
        const state = self.getCachedState(runId);
        if (!state) {
          throw createAgentError(
            "INVALID_STATE",
            `Run state not found: ${runId}`,
            false,
          );
        }
        return state;
      },

      async *stream(): AgentGenerator {
        const streamCtx = self.activeStreams.get(runId);
        if (!streamCtx) {
          // First stream call — create controller and start generator
          const controller = new AbortController();
          const gen = self.runAgentLoop(runId, input, controller.signal);
          self.activeStreams.set(runId, { controller, gen });
        }

        const ctx = self.activeStreams.get(runId)!;
        if (!ctx.gen) {
          // Generator was consumed (e.g., after pause) — rebuild
          const state = await self.adapter.loadState(runId);
          if (!state) return;

          const resumeInput: AgentInput = {
            ...input,
            runId,
            messages: state.messages,
            workingMemory: state.workingMemory,
          };
          ctx.gen = self.runAgentLoop(runId, resumeInput, ctx.controller.signal);
        }

        try {
          for await (const event of ctx.gen!) {
            // Persist each event
            await self.adapter.appendEvents(runId, [event]);

            if (event.type === "pause:approval" || event.type === "pause:input") {
              yield event;
              // Generator will be null after this — next stream() call rebuilds
              ctx.gen = null;
              return;
            }

            if (event.type === "run:finished") {
              // Update state on completion
              const state = await self.adapter.loadState(runId);
              if (state) {
                const newStatus: RunStatus =
                  event.outcome.finishReason === "stop" ||
                  event.outcome.finishReason === "handoff"
                    ? "completed"
                    : "failed";
                await self.adapter.saveState({
                  ...state,
                  status: newStatus,
                  messages: event.outcome.messages,
                  workingMemory: event.outcome.workingMemory,
                  tokenUsage: event.outcome.tokenUsage,
                  stepCount: event.outcome.totalSteps,
                  lastActiveAt: Date.now(),
                });
              }
              ctx.gen = null;
              yield event;
              return;
            }

            yield event;
          }
        } finally {
          // If generator ended without run:finished or pause, clean up
          if (ctx.gen) {
            ctx.gen = null;
          }
        }
      },

      async approve(callIds: string[]): Promise<void> {
        const state = await self.adapter.loadState(runId);
        if (!state || state.status !== "waiting_approval") return;

        // Record approvals in working memory for resume
        const approvals = callIds.map((id) => ({
          callId: id,
          action: "allow" as const,
        }));

        await self.adapter.saveState({
          ...state,
          status: "ready",
          workingMemory: {
            ...state.workingMemory,
            _resumeApprovals: approvals,
          },
        });
      },

      async deny(callIds: string[]): Promise<void> {
        const state = await self.adapter.loadState(runId);
        if (!state || state.status !== "waiting_approval") return;

        const denials = callIds.map((id) => ({
          callId: id,
          action: "deny" as const,
        }));

        await self.adapter.saveState({
          ...state,
          status: "ready",
          workingMemory: {
            ...state.workingMemory,
            _resumeApprovals: denials,
          },
        });
      },

      async provideInput(messages: Message[]): Promise<void> {
        const state = await self.adapter.loadState(runId);
        if (!state || state.status !== "waiting_input") return;

        await self.adapter.saveState({
          ...state,
          status: "ready",
          messages: [...state.messages, ...messages],
          lastActiveAt: Date.now(),
        });
      },

      async cancel(): Promise<void> {
        const ctx = self.activeStreams.get(runId);
        if (ctx) {
          ctx.controller.abort();
          self.activeStreams.delete(runId);
        }
        const state = await self.adapter.loadState(runId);
        if (state) {
          const cancelledState = {
            ...state,
            status: "cancelled" as const,
            lastActiveAt: Date.now(),
          };
          await self.adapter.saveState(cancelledState);
          self.setCachedState(cancelledState);
        }
      },

      async events(): Promise<AgentEvent[]> {
        return self.adapter.getEvents(runId);
      },
    };
  }

  private async *runAgentLoop(
    runId: string,
    input: AgentInput,
    signal: AbortSignal,
  ): AgentGenerator {
    // Get the current state to inject resume approvals
    const state = await this.adapter.loadState(runId);
    const resumeApprovals =
      (state?.workingMemory?._resumeApprovals as
        | { callId: string; action: "allow" | "deny" }[]
        | undefined) ?? [];

    // Clean up the _resumeApprovals from working memory
    if (resumeApprovals.length > 0 && state) {
      const { _resumeApprovals, ...cleanWM } = state.workingMemory;
      await this.adapter.saveState({
        ...state,
        workingMemory: cleanWM,
        status: "running" as RunStatus,
        lastActiveAt: Date.now(),
      });
    }

    const agentInput: AgentInput = {
      ...input,
      runId,
      signal,
      _internal: resumeApprovals.length > 0
        ? { resumeApprovals }
        : undefined,
    };

    for await (const event of this.agentFn(agentInput)) {
      // Update state in adapter on key events
      if (event.type === "step:started") {
        const s = await this.adapter.loadState(runId);
        if (s) {
          await this.adapter.saveState({
            ...s,
            status: "running" as RunStatus,
            stepCount: event.step,
            lastActiveAt: Date.now(),
          });
        }
      }

      if (event.type === "llm:done") {
        const s = await this.adapter.loadState(runId);
        if (s) {
          await this.adapter.saveState({
            ...s,
            tokenUsage: event.usage,
            messages: input.messages,
            lastActiveAt: Date.now(),
          });
        }
      }

      if (event.type === "pause:approval") {
        const s = await this.adapter.loadState(runId);
        if (s) {
          await this.adapter.saveState({
            ...s,
            status: "waiting_approval",
            lastActiveAt: Date.now(),
          });
        }
        yield event;
        return;
      }

      yield event;

      if (event.type === "run:finished") {
        return;
      }

      // Check for abort signal
      if (signal.aborted) {
        const s = await this.adapter.loadState(runId);
        if (s) {
          await this.adapter.saveState({
            ...s,
            status: "cancelled",
            lastActiveAt: Date.now(),
          });
        }
        yield {
          type: "run:cancelled",
          runId,
          step: s?.stepCount ?? 0,
        };
        return;
      }
    }
  }

  private getCachedState(runId: string): RunState | undefined {
    return this._localCache.get(runId);
  }

  private _localCache = new Map<string, RunState>();

  private setCachedState(state: RunState): void {
    this._localCache.set(state.runId, { ...state });
  }

  private async saveStateCached(state: RunState): Promise<void> {
    await this.adapter.saveState(state);
    this.setCachedState(state);
  }
}

/**
 * Factory function for RunManager (singleton-like).
 */
let _manager: RunManagerImpl | null = null;

export function getRunManager(agent: AgentFn, adapter?: PersistenceAdapter): RunManagerImpl {
  if (_manager) return _manager;
  _manager = new RunManagerImpl({ agent, adapter });
  return _manager;
}

export type { RunManagerImpl as RunManager };
