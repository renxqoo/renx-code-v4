import { LLMError } from "./errors";

/** True when `fetch` (or a compatible mock) aborted the request. */
export function isFetchAbortError(error: unknown): boolean {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "AbortError";
  }
  return error instanceof Error && error.name === "AbortError";
}

export function withOptionalTimeout(
  parent: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal: AbortSignal; dispose: () => void } {
  if (timeoutMs === undefined || timeoutMs <= 0) {
    const noop = (): void => {};
    if (!parent) {
      const c = new AbortController();
      return { signal: c.signal, dispose: noop };
    }
    return { signal: parent, dispose: noop };
  }

  const timeoutCtrl = new AbortController();
  const id = setTimeout(() => {
    timeoutCtrl.abort(
      new LLMError({
        code: "TIMEOUT",
        message: `Request timed out after ${timeoutMs}ms`,
        retryable: true,
      }),
    );
  }, timeoutMs);

  const clear = (): void => clearTimeout(id);

  if (!parent) {
    return { signal: timeoutCtrl.signal, dispose: clear };
  }

  if (parent.aborted) {
    clear();
    return { signal: parent, dispose: () => {} };
  }

  const merged = new AbortController();
  const done = (reason: unknown): void => {
    clear();
    if (!merged.signal.aborted) merged.abort(reason);
  };

  parent.addEventListener("abort", () => done(parent.reason), { once: true });
  timeoutCtrl.signal.addEventListener(
    "abort",
    () => done(timeoutCtrl.signal.reason),
    { once: true },
  );

  return { signal: merged.signal, dispose: clear };
}
