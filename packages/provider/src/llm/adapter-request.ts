import { mapFetchError } from "./internal/fetch-error";
import { withOptionalTimeout } from "./abort";
import type { AdapterInvokeContext } from "./adapter";

/**
 * Options for {@link withAdapterFetch}.
 */
export type AdapterFetchOptions = {
  /** HTTP method (default: `"POST"`). */
  method?: "GET" | "POST";
  /**
   * JSON body — when set, `Content-Type: application/json` is added automatically
   * and the value is serialised with `JSON.stringify`.
   */
  json?: Record<string, unknown>;
  /**
   * Raw body (e.g. `FormData`). Ignored when `json` is also provided.
   */
  body?: BodyInit;
  /** URL query parameters appended as `?key=value&…`. */
  params?: Record<string, string>;
  /** Extra headers (`Content-Type` and `Authorization` are set automatically). */
  headers?: Record<string, string>;
  /** Model ID included in error context. */
  modelId: string;
};

/**
 * Shared request skeleton used by every adapter method.
 *
 * Handles URL construction, abort-signal / timeout wiring, JSON body
 * serialisation, and the standard try/catch → `mapFetchError` / finally →
 * `dispose` pattern.
 *
 * The caller receives the raw `Response` inside `handler` and is responsible
 * for status-code checking and result extraction — adapter-specific logic that
 * differs between vendors.
 *
 * ```ts
 * return withAdapterFetch(ctx, "images/generations", {
 *   json: body, modelId: request.modelId,
 * }, async (res) => {
 *   if (!res.ok) throw await mapHttpError(res, request.modelId, VENDOR);
 *   const json = await res.json();
 *   return { images: extractImages(json), raw: json };
 * });
 * ```
 */
export async function withAdapterFetch<T>(
  ctx: AdapterInvokeContext,
  path: string,
  options: AdapterFetchOptions,
  handler: (res: Response) => Promise<T>,
): Promise<T> {
  const base = (ctx.baseUrl ?? "").replace(/\/$/, "");
  let url = base ? `${base}/${path}` : path;
  if (options.params && Object.keys(options.params).length > 0) {
    url += `?${new URLSearchParams(options.params)}`;
  }

  const { signal, dispose } = withOptionalTimeout(ctx.abortSignal, ctx.timeoutMs);
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${ctx.apiKey}`,
      ...options.headers,
    };
    let reqBody: BodyInit | undefined;
    if (options.json !== undefined) {
      if (!headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
      }
      reqBody = JSON.stringify(options.json);
    } else if (options.body !== undefined) {
      reqBody = options.body;
    }

    const res = await ctx.fetch(url, {
      method: options.method ?? "POST",
      headers,
      body: reqBody,
      signal,
    });
    return await handler(res);
  } catch (e) {
    mapFetchError(e, ctx.vendorId, options.modelId);
  } finally {
    dispose();
  }
}
