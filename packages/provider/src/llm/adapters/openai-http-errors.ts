import { LLMError, RetryableError } from "../errors";
import { readJsonOrText } from "../internal/util";

/**
 * Generic HTTP-status → LLMError mapping.
 * Shared by OpenAI, Anthropic, and any vendor with a similar error envelope.
 */
export async function mapHttpError(
  res: Response,
  modelId: string,
  vendor: string,
): Promise<LLMError> {
  const payload = await readJsonOrText(res);
  const msg =
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof (payload as { error?: { message?: unknown } }).error?.message === "string"
      ? String((payload as { error: { message: string } }).error.message)
      : typeof payload === "string"
        ? payload
        : res.statusText;
  const status = res.status;
  if (status === 401 || status === 403) {
    return new LLMError({
      code: "UNAUTHORIZED",
      message: msg,
      retryable: false,
      vendor,
      modelId,
      httpStatus: status,
    });
  }
  if (status === 429) {
    return new RetryableError({
      code: "RATE_LIMIT",
      message: msg,
      vendor,
      modelId,
      httpStatus: status,
    });
  }
  if (status >= 500) {
    return new RetryableError({
      code: "PROVIDER_ERROR",
      message: msg,
      vendor,
      modelId,
      httpStatus: status,
    });
  }
  if (status === 404) {
    return new LLMError({
      code: "MODEL_NOT_FOUND",
      message: msg,
      retryable: false,
      vendor,
      modelId,
      httpStatus: status,
    });
  }
  return new LLMError({
    code: "INVALID_REQUEST",
    message: msg,
    retryable: false,
    vendor,
    modelId,
    httpStatus: status,
  });
}
