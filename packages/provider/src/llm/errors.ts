export type LLMErrorCode =
  | "UNAUTHORIZED"
  | "RATE_LIMIT"
  | "QUOTA_EXCEEDED"
  | "INVALID_REQUEST"
  | "MODEL_NOT_FOUND"
  | "MODEL_NOT_AVAILABLE"
  | "NOT_IMPLEMENTED"
  | "TIMEOUT"
  | "NETWORK"
  | "PROVIDER_ERROR"
  | "INVALID_RESPONSE"
  | "CONTENT_FILTER"
  | "ABORTED"
  | "UNKNOWN";

export type LLMErrorInit = {
  code: LLMErrorCode;
  message: string;
  retryable: boolean;
  vendor?: string;
  modelId?: string;
  httpStatus?: number;
  cause?: unknown;
};

export class LLMError extends Error {
  readonly code: LLMErrorCode;
  readonly retryable: boolean;
  readonly vendor?: string;
  readonly modelId?: string;
  readonly httpStatus?: number;
  override readonly cause?: unknown;

  constructor(init: LLMErrorInit) {
    super(init.message);
    this.name = "LLMError";
    this.code = init.code;
    this.retryable = init.retryable;
    this.vendor = init.vendor;
    this.modelId = init.modelId;
    this.httpStatus = init.httpStatus;
    this.cause = init.cause;
  }

  static isInstance(e: unknown): e is LLMError {
    return e instanceof LLMError;
  }
}

export class RetryableError extends LLMError {
  constructor(init: Omit<LLMErrorInit, "retryable">) {
    super({ ...init, retryable: true });
    this.name = "RetryableError";
  }
}

export function isRetryableLlmError(e: unknown): boolean {
  return LLMError.isInstance(e) && e.retryable;
}
