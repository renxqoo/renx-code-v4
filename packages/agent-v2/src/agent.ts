import { generateId } from "./utils/id.js";
import { initState, type RunState } from "./state.js";
import {
  assistantMessage,
  systemMessage,
  toolMessage,
  userMessage,
  type ToolCall,
} from "./message.js";
import { type Tool } from "./tool.js";
import { createAgentError, type AgentError } from "./errors.js";
import {
  getDefaultLLMClient,
  type LLMStreamRequest,
  type LLMFinishChunk,
  type LLMErrorChunk,
  type OnToolsContext,
} from "./llm-client.js";
import type { AgentInput, AgentGenerator, AgentResult } from "./types.js";
import type { AgentEvent, LLMToolCallEvent } from "./events.js";
import { HandoffSignal } from "./handoff-signal.js";
import { toolToCanonical } from "./utils/converter.js";
import { estimateInputTokens, estimateOutputTokens } from "./utils/estimate-tokens.js";
import {
  accumulateToolCall,
  finalizeToolCall,
  type ToolAccEntry,
} from "./accumulator.js";

function buildResult(
  state: RunState,
  finishReason: AgentResult["finishReason"],
  error?: AgentError,
  handoff?: AgentResult["handoff"],
): AgentResult {
  const lastAssistant = [...state.messages]
    .reverse()
    .find((m) => m.role === "assistant");
  return {
    runId: state.runId,
    messages: state.messages,
    text:
      typeof lastAssistant?.content === "string" ? lastAssistant.content : "",
    workingMemory: state.workingMemory,
    tokenUsage: state.tokenUsage,
    finishReason,
    totalSteps: state.stepCount,
    ...(error ? { error } : {}),
    ...(handoff ? { handoff } : {}),
  };
}

async function executeSingleTool(
  tc: LLMToolCallEvent,
  tools: Tool[],
  state: RunState,
  signal?: AbortSignal,
): Promise<{
  output: unknown;
  durationMs: number;
  error?: AgentError;
}> {
  const tool = tools.find((t) => t.name === tc.name);
  if (!tool) {
    return {
      output: null,
      durationMs: 0,
      error: createAgentError(
        "TOOL_NOT_FOUND",
        `Tool not found: ${tc.name}`,
        false,
      ),
    };
  }
  const start = Date.now();
  try {
    const abortCtrl = new AbortController();
    if (signal) {
      signal.addEventListener("abort", () => abortCtrl.abort(), {
        once: true,
      });
    }
    const output = await tool.execute(tc.arguments, {
      runId: state.runId,
      workingMemory: state.workingMemory,
      signal: abortCtrl.signal,
    });
    return { output, durationMs: Date.now() - start };
  } catch (err) {
    // Check if it's a HandoffSignal - re-throw for caller to handle
    if (err instanceof HandoffSignal) throw err;
    return {
      output: null,
      durationMs: Date.now() - start,
      error: createAgentError(
        "TOOL_EXECUTION_FAILED",
        err instanceof Error ? err.message : String(err),
        false,
        err,
      ),
    };
  }
}

export async function* agent(input: AgentInput): AgentGenerator {
  const runId = input.runId ?? generateId();
  const maxSteps = input.maxSteps ?? 10;
  const toolExecution = input.toolExecution ?? "parallel";
  const llmClient = input.llmClient ?? getDefaultLLMClient();
  const tools = input.tools ?? [];
  let lengthWarningIssued = false;

  const systemPrompt = input.systemPrompt;
  const initialMessages = [...input.messages];
  const state = initState({
    runId,
    model: input.model,
    systemPrompt,
    messages: initialMessages,
    workingMemory: input.workingMemory,
  });

  yield {
    type: "run:started",
    runId,
    model: input.model,
    systemPrompt,
    tools: input.tools?.map((t) => t.name),
    maxSteps,
  } satisfies AgentEvent;

  while (state.stepCount < maxSteps) {
    const currentStep = state.stepCount + 1;
    state.stepCount = currentStep;
    state.lastActiveAt = Date.now();

    yield { type: "step:started", step: currentStep } satisfies AgentEvent;

    // Check abort signal before LLM call
    if (input.signal?.aborted) {
      yield {
        type: "run:cancelled",
        runId,
        step: currentStep,
      } satisfies AgentEvent;
      yield {
        type: "run:finished",
        outcome: buildResult(
          state,
          "cancelled",
          createAgentError("CANCELLED", "Run cancelled", false),
        ),
      } satisfies AgentEvent;
      return;
    }

    // Build LLM request
    const canonicalTools =
      tools.length > 0 ? tools.map(toolToCanonical) : undefined;
    const request: LLMStreamRequest = {
      model: state.model,
      systemPrompt: state.systemPrompt,
      messages: state.messages,
      ...(canonicalTools?.length ? { tools: canonicalTools } : {}),
    };

    // === Phase 1: LLM Stream ===
    let text = "";
    const accumulator = new Map<string, ToolAccEntry>();
    let doneChunk: LLMFinishChunk | null = null;
    let errorChunk: LLMErrorChunk | null = null;
    let streamError: unknown = null;
    let usageIsZero = false;

    try {
      const stream = llmClient.stream(request);
      for await (const chunk of stream) {
        if (input.signal?.aborted) {
          yield {
            type: "run:cancelled",
            runId,
            step: currentStep,
          } satisfies AgentEvent;
          yield {
            type: "run:finished",
            outcome: buildResult(
              state,
              "cancelled",
              createAgentError("CANCELLED", "Run cancelled", false),
            ),
          } satisfies AgentEvent;
          return;
        }

        switch (chunk.type) {
          case "text-delta":
            text += chunk.delta;
            yield {
              type: "llm:delta",
              step: currentStep,
              delta: chunk.delta,
            } satisfies AgentEvent;
            break;
          case "tool-call-delta":
            accumulateToolCall(accumulator, chunk);
            break;
          case "finish":
            doneChunk = chunk;
            usageIsZero = chunk.usage.input === 0 && chunk.usage.output === 0;
            if (!usageIsZero) {
              state.tokenUsage = {
                input: state.tokenUsage.input + chunk.usage.input,
                output: state.tokenUsage.output + chunk.usage.output,
                total:
                  state.tokenUsage.input +
                  state.tokenUsage.output +
                  chunk.usage.input +
                  chunk.usage.output,
                estimated: state.tokenUsage.estimated,
              };
            }
            break;
          case "error":
            errorChunk = chunk;
            break;
        }

        if (doneChunk || errorChunk) break;
      }
    } catch (err) {
      streamError = err;
    }

    // Handle stream exception
    if (streamError !== null) {
      const agentErr = createAgentError(
        "LLM_UNAVAILABLE",
        streamError instanceof Error
          ? streamError.message
          : String(streamError),
        true,
        streamError,
      );
      yield {
        type: "llm:done",
        step: currentStep,
        finishReason: "error",
        usage: state.tokenUsage,
        text: text || null,
        error: agentErr,
      } satisfies AgentEvent;
      yield {
        type: "run:finished",
        outcome: buildResult(state, "error", agentErr),
      } satisfies AgentEvent;
      return;
    }

    // Handle LLM error chunk
    if (errorChunk) {
      yield {
        type: "llm:done",
        step: currentStep,
        finishReason: "error",
        usage: state.tokenUsage,
        text: text || null,
        error: errorChunk.error,
      } satisfies AgentEvent;
      yield {
        type: "run:finished",
        outcome: buildResult(state, "error", errorChunk.error),
      } satisfies AgentEvent;
      return;
    }

    if (!doneChunk) {
      const agentErr = createAgentError(
        "LLM_UNAVAILABLE",
        "LLM stream ended without finish or error chunk",
        false,
      );
      yield {
        type: "llm:done",
        step: currentStep,
        finishReason: "error",
        usage: state.tokenUsage,
        text: text || null,
        error: agentErr,
      } satisfies AgentEvent;
      yield {
        type: "run:finished",
        outcome: buildResult(state, "error", agentErr),
      } satisfies AgentEvent;
      return;
    }

    // === Finalize tool calls from accumulator ===
    const finalToolCalls: LLMToolCallEvent[] = [];
    for (const [id] of accumulator) {
      const parsed = finalizeToolCall(accumulator, id);
      if (parsed) {
        const tcEvent: LLMToolCallEvent = {
          type: "llm:tool-call",
          step: currentStep,
          id,
          name: parsed.name,
          arguments: parsed.arguments,
        };
        finalToolCalls.push(tcEvent);
        yield tcEvent satisfies AgentEvent;
      }
    }

    // Estimate token usage if LLM returned all zeros (e.g., local models)
    if (usageIsZero) {
      const estInput = estimateInputTokens(
        state.systemPrompt,
        state.messages,
        canonicalTools,
      );
      const estOutput = estimateOutputTokens(text, finalToolCalls);
      const prevTotal =
        (state.tokenUsage.input ?? 0) + (state.tokenUsage.output ?? 0);
      state.tokenUsage = {
        input: state.tokenUsage.input + estInput,
        output: state.tokenUsage.output + estOutput,
        total: prevTotal + estInput + estOutput,
        estimated: true,
      };
    }

    // Yield llm:done
    yield {
      type: "llm:done",
      step: currentStep,
      finishReason: doneChunk.finishReason,
      usage: state.tokenUsage,
      text: text || null,
    } satisfies AgentEvent;

    // === Phase 2: Decision ===

    // Handle length (token limit) first — per DESIGN.md §4.3
    if (doneChunk.finishReason === "length") {
      // Append assistant message with whatever partial text was generated
      state.messages = [
        ...state.messages,
        assistantMessage(text || null),
      ];

      if (!lengthWarningIssued) {
        lengthWarningIssued = true;
        // Inject warning to give the LLM one more chance
        state.messages = [
          ...state.messages,
          userMessage(
            "You have reached the maximum response length. Please continue your response from where you left off.",
          ),
        ];
        yield {
          type: "step:completed",
          step: currentStep,
          finishReason: "length",
          tokenUsage: state.tokenUsage,
        } satisfies AgentEvent;
        continue;
      }

      // Second "length" → terminate
      const agentErr = createAgentError(
        "MAX_STEPS_REACHED",
        "Response exceeded maximum length after warning",
        false,
      );
      yield {
        type: "step:completed",
        step: currentStep,
        finishReason: "length",
        tokenUsage: state.tokenUsage,
      } satisfies AgentEvent;
      yield {
        type: "run:finished",
        outcome: buildResult(state, "max_steps", agentErr),
      } satisfies AgentEvent;
      return;
    }

    // Append assistant message (with tool calls if any)
    const toolCallsForMsg: ToolCall[] = finalToolCalls.map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    }));
    state.messages = [
      ...state.messages,
      assistantMessage(
        text || null,
        toolCallsForMsg.length > 0 ? toolCallsForMsg : undefined,
      ),
    ];

    // If no tool calls → run is complete
    if (finalToolCalls.length === 0) {
      yield {
        type: "step:completed",
        step: currentStep,
        finishReason: doneChunk.finishReason,
        tokenUsage: state.tokenUsage,
      } satisfies AgentEvent;
      yield {
        type: "run:finished",
        outcome: buildResult(state, "stop"),
      } satisfies AgentEvent;
      return;
    }

    // === Phase 3: onTools injection point ===
    let allowedToolCalls = finalToolCalls;
    let aborted = false;
    let abortReason = "";

    if (input.onTools) {
      const ctx: OnToolsContext = {
        toolCalls: finalToolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          args: tc.arguments,
        })),
        state,
        priorApprovals: input._internal?.resumeApprovals,
      };

      const decision = await input.onTools(ctx);

      switch (decision.action) {
        case "deny": {
          const denySet = new Set(decision.callIds);
          allowedToolCalls = finalToolCalls.filter(
            (tc) => !denySet.has(tc.id),
          );
          for (const tc of finalToolCalls) {
            if (denySet.has(tc.id)) {
              const errorMsg = `Tool call denied: ${tc.name}`;
              yield {
                type: "tool:error",
                callId: tc.id,
                error: errorMsg,
              } satisfies AgentEvent;
              state.messages = [
                ...state.messages,
                toolMessage(tc.id, `Error: ${errorMsg}`),
              ];
            }
          }
          break;
        }
        case "abort":
          aborted = true;
          abortReason = decision.reason;
          break;
        case "pause": {
          const pauseCallIds = decision.callIds;
          const pausedTools = finalToolCalls.filter((tc) =>
            pauseCallIds.includes(tc.id),
          );
          yield {
            type: "pause:approval",
            runId,
            callIds: pauseCallIds,
            tools: pausedTools.map((t) => t.name),
            arguments: pausedTools.map((t) => t.arguments),
          } satisfies AgentEvent;
          return;
        }
        case "execute":
        default:
          allowedToolCalls = finalToolCalls;
          break;
      }
    }

    if (aborted) {
      yield {
        type: "run:finished",
        outcome: buildResult(
          state,
          "error",
          createAgentError("INVALID_STATE", abortReason, false),
        ),
      } satisfies AgentEvent;
      return;
    }

    // === Phase 4: Execute tools (inline to support yield) ===
    if (allowedToolCalls.length > 0) {
      if (toolExecution === "sequential") {
        for (const tc of allowedToolCalls) {
          yield {
            type: "tool:start",
            callId: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          } satisfies AgentEvent;

          const tool = tools.find((t) => t.name === tc.name);
          if (!tool) {
            const errorMsg = `Tool not found: ${tc.name}`;
            yield {
              type: "tool:error",
              callId: tc.id,
              error: errorMsg,
            } satisfies AgentEvent;
            state.messages = [
              ...state.messages,
              toolMessage(tc.id, `Error: ${errorMsg}`),
            ];
            continue;
          }

          const start = Date.now();
          try {
            const abortCtrl = new AbortController();
            if (input.signal) {
              input.signal.addEventListener(
                "abort",
                () => abortCtrl.abort(),
                { once: true },
              );
            }
            const output = await tool.execute(tc.arguments, {
              runId: state.runId,
              workingMemory: state.workingMemory,
              signal: abortCtrl.signal,
            });
            const durationMs = Date.now() - start;
            yield {
              type: "tool:result",
              callId: tc.id,
              ok: true,
              output,
              durationMs,
            } satisfies AgentEvent;
            state.messages = [
              ...state.messages,
              toolMessage(tc.id, JSON.stringify(output)),
            ];
          } catch (err) {
            if (err instanceof HandoffSignal) {
              yield {
                type: "handoff",
                from: runId,
                to: err.targetAgent,
                reason: err.reason,
              } satisfies AgentEvent;
              yield {
                type: "run:finished",
                outcome: buildResult(state, "handoff", undefined, {
                  targetAgent: err.targetAgent,
                  reason: err.reason,
                }),
              } satisfies AgentEvent;
              return;
            }
            const errorMsg =
              err instanceof Error ? err.message : String(err);
            yield {
              type: "tool:error",
              callId: tc.id,
              error: errorMsg,
            } satisfies AgentEvent;
            state.messages = [
              ...state.messages,
              toolMessage(tc.id, `Error: ${errorMsg}`),
            ];
          }
        }
      } else {
        // Parallel execution:
        // 1. Yield all tool:start events first
        for (const tc of allowedToolCalls) {
          yield {
            type: "tool:start",
            callId: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          } satisfies AgentEvent;
        }

        // 2. Execute all concurrently (no yield in callbacks)
        const results = await Promise.allSettled(
          allowedToolCalls.map((tc) =>
            executeSingleTool(tc, tools, state, input.signal),
          ),
        );

        // 3. Yield result/error events sequentially
        for (let i = 0; i < results.length; i++) {
          const tc = allowedToolCalls[i]!;
          const result = results[i]!;

          if (result.status === "fulfilled") {
            const { output, durationMs, error } = result.value;
            if (error) {
              yield {
                type: "tool:error",
                callId: tc.id,
                error: error.message,
              } satisfies AgentEvent;
              state.messages = [
                ...state.messages,
                toolMessage(tc.id, `Error: ${error.message}`),
              ];
            } else {
              yield {
                type: "tool:result",
                callId: tc.id,
                ok: true,
                output,
                durationMs,
              } satisfies AgentEvent;
              state.messages = [
                ...state.messages,
                toolMessage(tc.id, JSON.stringify(output)),
              ];
            }
          } else {
            const reason = result.reason;
            if (reason instanceof HandoffSignal) {
              yield {
                type: "handoff",
                from: runId,
                to: reason.targetAgent,
                reason: reason.reason,
              } satisfies AgentEvent;
              yield {
                type: "run:finished",
                outcome: buildResult(state, "handoff", undefined, {
                  targetAgent: reason.targetAgent,
                  reason: reason.reason,
                }),
              } satisfies AgentEvent;
              return;
            }
            const errorMsg =
              reason instanceof Error ? reason.message : String(reason);
            yield {
              type: "tool:error",
              callId: tc.id,
              error: errorMsg,
            } satisfies AgentEvent;
            state.messages = [
              ...state.messages,
              toolMessage(tc.id, `Error: ${errorMsg}`),
            ];
          }
        }
      }
    }

    // Yield step:completed
    yield {
      type: "step:completed",
      step: currentStep,
      finishReason: "tool_calls",
      tokenUsage: state.tokenUsage,
    } satisfies AgentEvent;
  }

  // Max steps reached
  yield {
    type: "run:finished",
    outcome: buildResult(
      state,
      "max_steps",
      createAgentError("MAX_STEPS_REACHED", "Maximum steps reached", false),
    ),
  } satisfies AgentEvent;
}
