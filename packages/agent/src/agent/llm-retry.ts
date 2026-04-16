import type { LlmRetryConfig } from "./types";

/**
 * `shared.llmRetryRemaining`：核心循环在单次 LLM 调用失败时递减并重试（与「模型名 / model id」无关）。
 * 初始值由 `runQueryModelLoop` 在 `beforeRun` 之后按 `Agent.llmRetry` / 默认值写入；也可在自定义中间件的 `beforeRun` 里直接写 `ctx.shared`（已设置则不再覆盖）。
 */
export const LLM_RETRY_REMAINING_KEY = "llmRetryRemaining" as const;

/**
 * 未配置 `llmRetry` 时使用的默认「再试次数」。
 * 与 `LlmRetryConfig.maxRetries` 语义一致：首次失败后最多再发起几次新请求（不含首次）。
 */
export const DEFAULT_LLM_MAX_RETRIES = 2;

/**
 * `attemptIndex`：本轮内第几次「重试前等待」（从 0 起：第一次重试前为 0，第二次重试前为 1）。
 */
export function computeRetryDelayMs(cfg: LlmRetryConfig | undefined, attemptIndex: number): number {
  const base = Math.max(0, Math.floor(cfg?.retryDelayMs ?? 0));
  if (base <= 0) return 0;
  const mult = cfg?.retryBackoffMultiplier ?? 1;
  const safeMult = Number.isFinite(mult) && mult >= 0 ? mult : 1;
  const idx = Math.max(0, Math.floor(attemptIndex));
  const raw = base * Math.pow(safeMult, idx);
  const maxCap = cfg?.retryMaxDelayMs;
  const capped =
    maxCap != null && Number.isFinite(maxCap) && maxCap >= 0 ? Math.min(raw, maxCap) : raw;
  return Math.min(0x7fffffff, Math.round(capped));
}

/**
 * Subscribe-first-then-check: avoids the race where the signal aborts between
 * the initial `aborted` check and the `addEventListener` call.
 */
export async function sleepRetryDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("Aborted");
    }
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(id);
      reject(signal!.reason ?? new Error("Aborted"));
    };
    // Subscribe first, then check — eliminates the race window.
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
  });
}
