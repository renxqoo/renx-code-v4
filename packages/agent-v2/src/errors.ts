export type AgentErrorCode =
  | "LLM_UNAVAILABLE"
  | "LLM_RATE_LIMITED"
  | "LLM_CONTENT_FILTER"
  | "LLM_TOKEN_LIMIT"
  | "TOOL_NOT_FOUND"
  | "TOOL_EXECUTION_FAILED"
  | "TOOL_TIMEOUT"
  | "CANCELLED"
  | "MAX_STEPS_REACHED"
  | "INVALID_STATE";

export type AgentError = {
  code: AgentErrorCode;
  message: string;
  retryable: boolean;
  cause?: unknown;
};

export function createAgentError(
  code: AgentErrorCode,
  message: string,
  retryable = false,
  cause?: unknown,
): AgentError {
  return { code, message, retryable, ...(cause !== undefined ? { cause } : {}) };
}
