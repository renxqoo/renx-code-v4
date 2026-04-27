import type {
  LLMClient,
  LLMStreamGenerator,
  LLMStreamRequest,
  TokenUsage,
} from "../../src/llm-client.js";
import type { AgentError } from "../../src/errors.js";
import { createAgentError } from "../../src/errors.js";

export type ChunkSpec =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call-delta"; id: string; name: string; argsDelta: string }
  | { type: "finish"; finishReason: string; usage?: TokenUsage }
  | { type: "error"; error: AgentError };

/**
 * Creates a mock LLM client that yields one chunk list per stream() call.
 * Each element of chunkLists is a complete LLM response (one "turn").
 */
export function createMockLLMClient(
  ...chunkLists: ChunkSpec[][]
): LLMClient {
  let callIndex = 0;
  return {
    stream(_request: LLMStreamRequest): LLMStreamGenerator {
      return mockStream(chunkLists[callIndex++] ?? [], _request);
    },
  };
}

async function* mockStream(
  chunks: ChunkSpec[] | undefined,
  _request: LLMStreamRequest,
): LLMStreamGenerator {
  for (const chunk of chunks ?? []) {
    switch (chunk.type) {
      case "text-delta":
        yield { type: "text-delta", delta: chunk.delta };
        break;
      case "tool-call-delta":
        yield {
          type: "tool-call-delta",
          id: chunk.id,
          name: chunk.name,
          argsDelta: chunk.argsDelta,
        };
        break;
      case "finish": {
        const usage = chunk.usage ?? { input: 10, output: 5 };
        yield { type: "finish", finishReason: chunk.finishReason, usage };
        break;
      }
      case "error":
        yield { type: "error", error: chunk.error };
        break;
    }
  }
}

export function createSingleResponseClient(chunks: ChunkSpec[]): LLMClient {
  return createMockLLMClient(chunks);
}

export function createMultiStepClient(
  ...stepChunks: ChunkSpec[][]
): LLMClient {
  return createMockLLMClient(...stepChunks);
}

export function createTextDeltaChunk(delta: string): ChunkSpec {
  return { type: "text-delta", delta };
}

export function createToolCallDeltaChunk(
  id: string,
  name: string,
  argsDelta: string,
): ChunkSpec {
  return { type: "tool-call-delta", id, name, argsDelta };
}

export function createFinishChunk(
  finishReason: string,
  usage?: TokenUsage,
): ChunkSpec {
  return { type: "finish", finishReason, usage };
}

export function createErrorChunk(
  message: string,
  code = "LLM_UNAVAILABLE" as const,
): ChunkSpec {
  return {
    type: "error",
    error: createAgentError(code, message, true),
  };
}
