import { LLMError, RetryableError } from "../errors";
import { isFetchAbortError } from "../abort";

/**
 * Shared fetch-exception → LLMError mapping used by every adapter.
 *
 * Always throws (return type is `never`).
 */
export function mapFetchError(e: unknown, vendor: string, modelId: string): never {
  if (LLMError.isInstance(e)) throw e;
  if (isFetchAbortError(e)) {
    throw new LLMError({
      code: "ABORTED",
      message: "Request aborted",
      retryable: false,
      vendor,
      modelId,
      cause: e,
    });
  }
  if (e instanceof TypeError) {
    throw new RetryableError({
      code: "NETWORK",
      message: (e as TypeError).message,
      vendor,
      modelId,
      cause: e,
    });
  }
  throw new LLMError({
    code: "UNKNOWN",
    message: e instanceof Error ? e.message : String(e),
    retryable: false,
    vendor,
    modelId,
    cause: e,
  });
}
