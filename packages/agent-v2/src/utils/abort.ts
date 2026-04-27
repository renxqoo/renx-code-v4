/**
 * AbortSignal utilities for plugin use.
 */

/**
 * Create an AbortSignal that fires after `durationMs` milliseconds.
 */
export function timeoutSignal(durationMs: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), durationMs);
  return controller.signal;
}

/**
 * Merge two AbortSignals — the result fires when either source fires.
 */
export function raceSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  if (a.aborted || b.aborted) controller.abort();
  return controller.signal;
}

/**
 * Promise that resolves when the signal fires, rejects on timeout.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    }
  });
}
