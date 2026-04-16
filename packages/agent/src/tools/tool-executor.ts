import type { SandboxRegistry } from "../sandbox/sandbox-registry";
import type { SandboxExecutionContext } from "../sandbox/types";
import type { AgentTool, AgentToolExecutionResult } from "./type";
import { toolResultError, validateTool } from "./util";

/**
 * Execute a promise with a timeout. Returns a failure `AgentToolExecutionResult` if the
 * promise does not settle within `timeoutMs`, otherwise returns the original result.
 */
function withTimeout(
  promise: Promise<AgentToolExecutionResult>,
  timeoutMs: number,
  toolName: string,
  callId: string,
  args: Record<string, unknown>,
): Promise<AgentToolExecutionResult> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<AgentToolExecutionResult>((resolve) => {
    timer = setTimeout(() => {
      resolve(
        toolResultError(toolName, callId, args, new Error(`Tool execution timed out after ${timeoutMs}ms`)),
      );
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

const executorInProcess = async ({
  toolCall,
  args,
  callId,
}: {
  toolCall: AgentTool;
  args: Record<string, unknown>;
  callId: string;
}): Promise<AgentToolExecutionResult> => {
  try {
    const toolArgs = validateTool({ toolCall, args });
    const exec = toolCall.execute(toolArgs);
    const timeoutMs = toolCall.timeoutMs;
    return timeoutMs ? withTimeout(exec, timeoutMs, toolCall.name, callId, args) : exec;
  } catch (error) {
    return toolResultError(toolCall.name, callId, args, error as Error);
  }
};

export type ToolExecutorSandboxOptions = {
  sandboxRegistry: SandboxRegistry;
  getSandboxContext: (tool: AgentTool) => SandboxExecutionContext;
};

/** After a write-phase failure, skipped write/read tools still get explicit failure rows so callers keep aligned slots. */
function resultSkippedAfterWriteFailure(
  tool: AgentTool,
  callId: string,
  kind: "pending_write" | "read",
): AgentToolExecutionResult {
  const content =
    kind === "read"
      ? `Tool [${tool.name}] was not run: a write tool failed, the concurrent read phase was cancelled, and remaining concurrent work was not executed.`
      : `Tool [${tool.name}] was not run: an earlier write tool failed; subsequent writes and the concurrent read phase were aborted.`;
  return {
    success: false,
    content,
    metadata: {
      name: tool.name,
      id: callId,
      skipped: true,
      reason: "write_phase_failed",
      kind,
    },
  };
}

type Invocation = { tool: AgentTool; args: Record<string, unknown>; callId: string };

type IndexedInvocation = Invocation & { index: number };

/**
 * Execute a batch of tool invocations with read/write phase separation.
 *
 * **Write tools** (`type: "write_only" | "read_write"`) are executed **sequentially** in order.
 * If any write tool fails, all remaining writes **and** the entire read phase are skipped
 * (each skipped invocation gets a `resultSkippedAfterWriteFailure` row).
 *
 * **Read tools** (`type: "read_only"`) are executed **concurrently** via `Promise.all`,
 * but only after all write tools have succeeded.
 *
 * **Sandbox integration**: When `sandbox` options are provided, each tool execution is routed
 * through `SandboxRegistry.resolve(profileId)` to the appropriate `SandboxBackend`.
 * Without sandbox options, tools run in-process via `executorInProcess`.
 *
 * **Timeout**: If a tool has `timeoutMs` set, its execution is wrapped in a `Promise.race`
 * with a timeout. On timeout, a failure result is returned instead of hanging indefinitely.
 *
 * @param invocations - Ordered list of `{ tool, args, callId }` to execute.
 * @param sandbox - Optional sandbox configuration for isolated execution.
 * @returns An array of `AgentToolExecutionResult` aligned 1:1 with the input `invocations`.
 */
export async function toolExecutor(
  invocations: Invocation[],
  sandbox?: ToolExecutorSandboxOptions,
): Promise<AgentToolExecutionResult[]> {
  if (invocations.length === 0) {
    return [];
  }

  const runOne = async (tool: AgentTool, args: Record<string, unknown>, callId: string) => {
    if (sandbox) {
      const context = sandbox.getSandboxContext(tool);
      const result = sandbox.sandboxRegistry.resolve(context.profileId).execute({
        tool,
        args,
        callId,
        context,
      });
      return withTimeout(result, tool.timeoutMs ?? 0, tool.name, callId, args);
    }
    return executorInProcess({ toolCall: tool, args, callId });
  };

  const writeQueue: IndexedInvocation[] = [];
  const readQueue: IndexedInvocation[] = [];
  invocations.forEach((inv, index) => {
    const row: IndexedInvocation = { ...inv, index };
    if (inv.tool.type === "read_only") {
      readQueue.push(row);
    } else {
      writeQueue.push(row);
    }
  });

  const results: AgentToolExecutionResult[] = new Array(invocations.length);

  for (let w = 0; w < writeQueue.length; w++) {
    const { tool, args, callId, index } = writeQueue[w];
    const result = await runOne(tool, args, callId);
    results[index] = result;
    if (!result.success) {
      for (let w2 = w + 1; w2 < writeQueue.length; w2++) {
        const { tool: t, callId: cid, index: i } = writeQueue[w2];
        results[i] = resultSkippedAfterWriteFailure(t, cid, "pending_write");
      }
      for (const { tool: t, callId: cid, index: i } of readQueue) {
        results[i] = resultSkippedAfterWriteFailure(t, cid, "read");
      }
      return results;
    }
  }

  if (readQueue.length > 0) {
    const readOutcomes = await Promise.all(
      readQueue.map(({ tool, args, callId }) => runOne(tool, args, callId)),
    );
    readQueue.forEach(({ index }, j) => {
      results[index] = readOutcomes[j];
    });
  }

  return results;
}
