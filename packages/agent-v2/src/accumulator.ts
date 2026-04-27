import type { LLMToolCallDeltaChunk } from "./llm-client.js";

/**
 * Internal accumulator entry for a single tool call being streamed.
 */
export type ToolAccEntry = {
  name: string;
  argsBuffer: string;
  complete: boolean;
};

/**
 * Accumulate a tool-call-delta chunk into the accumulator map.
 * Creates a new entry if none exists for the given delta id.
 *
 * Per DESIGN.md C.2: tool-call-delta chunks are accumulated per call-id
 * and only finalized when the finish chunk arrives.
 */
export function accumulateToolCall(
  acc: Map<string, ToolAccEntry>,
  delta: LLMToolCallDeltaChunk,
): void {
  let entry = acc.get(delta.id);
  if (!entry) {
    entry = { name: delta.name, argsBuffer: "", complete: false };
    acc.set(delta.id, entry);
  }
  if (delta.name && !entry.name) {
    entry.name = delta.name;
  }
  entry.argsBuffer += delta.argsDelta;
}

/**
 * Finalize a tool call from the accumulator by parsing its JSON args buffer.
 * Returns null if the entry doesn't exist or JSON parsing fails.
 */
export function finalizeToolCall(
  acc: Map<string, ToolAccEntry>,
  id: string,
): { name: string; arguments: Record<string, unknown> } | null {
  const entry = acc.get(id);
  if (!entry) return null;
  entry.complete = true;
  try {
    const parsed = JSON.parse(entry.argsBuffer);
    return { name: entry.name, arguments: parsed };
  } catch {
    return null;
  }
}
