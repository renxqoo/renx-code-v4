import type { LLMErrorCode } from "./errors";

const DEFAULT_PUBLIC =
  "Something went wrong. Please try again in a moment.";

const MAP: Partial<Record<LLMErrorCode, string>> = {
  UNAUTHORIZED:
    "You do not have permission to use this service. Contact an administrator.",
  RATE_LIMIT: "Too many requests. Please wait and try again.",
  QUOTA_EXCEEDED: "Usage limit reached. Contact an administrator.",
  INVALID_REQUEST: "The request was invalid. Check your input and try again.",
  MODEL_NOT_FOUND: "The requested model is not available.",
  MODEL_NOT_AVAILABLE: "The model is temporarily unavailable. Try again later.",
  NOT_IMPLEMENTED: "This action is not supported for the selected provider.",
  TIMEOUT: "The request timed out. Please try again.",
  NETWORK: "A network error occurred. Please try again.",
  PROVIDER_ERROR: "The upstream service had a problem. Please try again later.",
  INVALID_RESPONSE: "The response could not be processed. Please try again.",
  CONTENT_FILTER:
    "Your request did not pass safety checks. Revise it and try again.",
  ABORTED: "The request was cancelled.",
  UNKNOWN: DEFAULT_PUBLIC,
};

export function toPublicMessage(code: LLMErrorCode): string {
  return MAP[code] ?? DEFAULT_PUBLIC;
}
