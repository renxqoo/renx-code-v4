import type {
  CanonicalFinishReason,
  CanonicalStreamChunk,
  CanonicalToolCall,
  CanonicalUsage,
  LLMClient,
  StreamTextResult,
} from "@renx/provider";
import { streamText } from "@renx/provider";
import type { QueryModelType } from "../domain/query-model";

async function* emptyTextStream(): AsyncGenerator<CanonicalStreamChunk> {}

function erroredStreamTextResult(error: unknown): StreamTextResult {
  return {
    textStream: emptyTextStream(),
    text: Promise.resolve(""),
    reasoning: Promise.resolve(""),
    toolCalls: Promise.resolve([]),
    usage: Promise.resolve(undefined),
    finishReason: Promise.resolve("error"),
  };
}

export type RuntimeOk = { ok: true } & StreamTextResult;

export type RuntimeErr = {
  ok: false;
  error: unknown;
  textStream: AsyncIterable<CanonicalStreamChunk>;
  text: Promise<string>;
  reasoning: Promise<string>;
  toolCalls: Promise<CanonicalToolCall[]>;
  usage: Promise<CanonicalUsage | undefined>;
  finishReason: Promise<CanonicalFinishReason>;
};

export type RuntimeOutcome = RuntimeOk | RuntimeErr;

/**
 * Error thrown by `runtime()` for recoverable errors (LLM API failures, network issues, aborts).
 * Programming errors (TypeError, ReferenceError, etc.) are **not** wrapped — they propagate upward.
 */
export class RuntimeError extends Error {
  readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "RuntimeError";
    this.cause = cause;
  }
}

/**
 * Returns `true` for errors that `runtime()` should catch and wrap as `RuntimeOutcome { ok: false }`.
 * Programming errors (TypeError, SyntaxError, ReferenceError, RangeError) are considered unrecoverable
 * and propagate upward so callers discover bugs immediately.
 */
export function isRecoverableError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof RuntimeError) return true;
  // Network / fetch errors (TypeError from failed fetch)
  if (err instanceof TypeError) {
    const msg = err.message ?? "";
    // Only network-related TypeErrors are recoverable (e.g. "fetch failed", "Network request failed")
    if (/network|fetch|abort|timeout|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(msg)) return true;
    return false;
  }
  // Explicit programming errors — never recover
  if (err instanceof SyntaxError) return false;
  if (err instanceof ReferenceError) return false;
  if (err instanceof RangeError) return false;
  // LLM / API errors with status codes are recoverable
  if (err && typeof err === "object" && "status" in err) return true;
  // Generic Error instances (e.g. provider API errors) are recoverable
  if (err instanceof Error) return true;
  // Unknown error types — treat as recoverable to avoid crashing
  return true;
}

export async function runtime(config: QueryModelType, llmClient?: LLMClient): Promise<RuntimeOutcome> {
  try {
    const result =
      llmClient != null ? await llmClient.streamText(config) : await streamText(config);
    return { ok: true, ...result };
  } catch (err) {
    if (!isRecoverableError(err)) {
      throw err;
    }
    const fallback = erroredStreamTextResult(err);
    return {
      ok: false,
      error: err,
      ...fallback,
    };
  }
}
