import type { AgentTool, AgentToolExecutionResult, ToolCall } from "./type";
import { validateTool } from "./util";

const toolResultError = (toolCall: ToolCall, error: Error): AgentToolExecutionResult => {
  return {
    success: false,
    content: `tool [${toolCall.name}] execution failed: ${error.toString()}`,
    metadata: {
      name: toolCall.name,
      id: toolCall.id,
      args: toolCall.args,
      error: error.toString(),
    },
  };
};

const executor = async ({
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
    const result = await toolCall.execute(toolArgs);
    return result;
  } catch (error) {
    return toolResultError(
      {
        id: callId,
        name: toolCall.name,
        args,
      },
      error as Error,
    );
  }
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

export async function toolExecutor(invocations: Invocation[]): Promise<AgentToolExecutionResult[]> {
  if (invocations.length === 0) {
    return [];
  }

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
    const result = await executor({ toolCall: tool, args, callId });
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
      readQueue.map(({ tool, args, callId }) => executor({ toolCall: tool, args, callId })),
    );
    readQueue.forEach(({ index }, j) => {
      results[index] = readOutcomes[j];
    });
  }

  return results;
}
