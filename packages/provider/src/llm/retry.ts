import { LLMError, isRetryableLlmError } from "./errors";

export type RetryPolicy = {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterRatio: number;
};

export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 200,
  maxDelayMs: 10_000,
  backoffMultiplier: 2,
  jitterRatio: 0.2,
};

export function mergeRetryPolicy(
  base: RetryPolicy,
  partial?: Partial<RetryPolicy>,
): RetryPolicy {
  if (!partial) return base;
  return { ...base, ...partial };
}

function computeDelayMs(attemptIndex: number, policy: RetryPolicy): number {
  const base =
    policy.initialDelayMs *
    Math.pow(policy.backoffMultiplier, Math.max(0, attemptIndex - 1));
  const capped = Math.min(base, policy.maxDelayMs);
  const jitter = capped * policy.jitterRatio * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError(signal.reason));
      return;
    }
    const id = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(id);
      reject(abortedError(signal?.reason));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortedError(reason: unknown): LLMError {
  return new LLMError({
    code: "ABORTED",
    message: "Request aborted",
    retryable: false,
    cause: reason,
  });
}

export type ExecuteWithRetryOptions = {
  policy: RetryPolicy;
  abortSignal?: AbortSignal;
  deadlineMs?: number;
  isRetryable: (error: unknown) => boolean;
  onRetry?: (info: { attempt: number; error: unknown }) => void;
};

export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  options: ExecuteWithRetryOptions,
): Promise<T> {
  if (options.policy.maxAttempts < 1) {
    throw new LLMError({
      code: "INVALID_REQUEST",
      message: "maxAttempts must be at least 1",
      retryable: false,
    });
  }

  const deadlineAt =
    options.deadlineMs !== undefined
      ? Date.now() + options.deadlineMs
      : undefined;

  for (let attempt = 1; attempt <= options.policy.maxAttempts; attempt++) {
    if (options.abortSignal?.aborted) {
      throw abortedError(options.abortSignal.reason);
    }

    if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
      throw new LLMError({
        code: "TIMEOUT",
        message: "Deadline exceeded before attempt",
        retryable: true,
      });
    }

    try {
      return await fn();
    } catch (e) {
      if (options.abortSignal?.aborted) {
        throw abortedError(options.abortSignal.reason);
      }

      const retryable = options.isRetryable(e);
      if (!retryable || attempt >= options.policy.maxAttempts) {
        throw e;
      }

      const delayMs = computeDelayMs(attempt, options.policy);
      if (deadlineAt !== undefined && Date.now() + delayMs >= deadlineAt) {
        throw e;
      }

      options.onRetry?.({ attempt, error: e });
      await sleep(delayMs, options.abortSignal);
    }
  }

  throw new Error("@renx/provider: executeWithRetry fell through");
}

export function defaultIsRetryable(error: unknown): boolean {
  return isRetryableLlmError(error);
}
