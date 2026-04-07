import { LLMError, RetryableError } from "../errors";
import type { LLMAdapter, AdapterInvokeContext } from "../adapter";
import { createOpenAIAdapter } from "../adapters/openai-adapter";
import { isFetchAbortError, withOptionalTimeout } from "../abort";
import { readJsonOrText } from "../http-util";
import type {
  CanonicalImageRequest,
  CanonicalImageResult,
  CanonicalSpeechRequest,
  CanonicalSpeechResult,
  CanonicalVideoContentResult,
  CanonicalVideoDownloadQuery,
  CanonicalVideoJob,
  CanonicalVideoJobQuery,
  CanonicalVideoRequest,
  CanonicalVideoResult,
} from "../types";
import { MINIMAXI_VENDOR_ID } from "./credentials";

const VENDOR = MINIMAXI_VENDOR_ID;
/** @see https://platform.minimaxi.com/docs/api-reference/api-overview */
const DEFAULT_BASE = "https://api.minimaxi.com";

function relabelVendor(e: LLMError, vendor: string): LLMError {
  if (e.vendor === vendor) return e;
  return new LLMError({
    code: e.code,
    message: e.message,
    retryable: e.retryable,
    vendor,
    modelId: e.modelId,
    httpStatus: e.httpStatus,
    cause: e.cause,
  });
}

function assertMiniMaxBaseResp(
  base: { status_code?: unknown; status_msg?: unknown } | undefined,
  modelId: string,
): void {
  if (!base) return;
  const code = base.status_code;
  if (code === 0 || code === undefined) return;
  const msg = String(base.status_msg ?? "MiniMax API error");
  const c = typeof code === "number" ? code : Number(code);
  if (c === 1002) {
    throw new RetryableError({
      code: "RATE_LIMIT",
      message: msg,
      vendor: VENDOR,
      modelId,
    });
  }
  if (c === 1004 || c === 2049) {
    throw new LLMError({
      code: "UNAUTHORIZED",
      message: msg,
      retryable: false,
      vendor: VENDOR,
      modelId,
    });
  }
  if (c === 1008) {
    throw new LLMError({
      code: "QUOTA_EXCEEDED",
      message: msg,
      retryable: false,
      vendor: VENDOR,
      modelId,
    });
  }
  if (c === 1026 || c === 1027) {
    throw new LLMError({
      code: "CONTENT_FILTER",
      message: msg,
      retryable: false,
      vendor: VENDOR,
      modelId,
    });
  }
  throw new LLMError({
    code: "INVALID_REQUEST",
    message: msg,
    retryable: false,
    vendor: VENDOR,
    modelId,
  });
}

function mapQueryStatus(s: string): CanonicalVideoJob["status"] {
  switch (s) {
    case "Preparing":
    case "Queueing":
      return "queued";
    case "Processing":
      return "in_progress";
    case "Success":
      return "completed";
    case "Fail":
      return "failed";
    default:
      return "other";
  }
}

function hexToBytes(hex: string, modelId: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, "");
  if (clean.length % 2 !== 0) {
    throw new LLMError({
      code: "INVALID_RESPONSE",
      message: "Invalid hex audio payload from MiniMax",
      retryable: false,
      vendor: VENDOR,
      modelId,
    });
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function fetchError(e: unknown, modelId: string): never {
  if (LLMError.isInstance(e)) throw e;
  if (isFetchAbortError(e)) {
    throw new LLMError({
      code: "ABORTED",
      message: "Request aborted",
      retryable: false,
      vendor: VENDOR,
      modelId,
      cause: e,
    });
  }
  if (e instanceof TypeError) {
    throw new RetryableError({
      code: "NETWORK",
      message: e.message,
      vendor: VENDOR,
      modelId,
      cause: e,
    });
  }
  throw new LLMError({
    code: "UNKNOWN",
    message: e instanceof Error ? e.message : String(e),
    retryable: false,
    vendor: VENDOR,
    modelId,
    cause: e,
  });
}

function createMinimaxiMultimodalMethods() {
  return {
    async generateImage(
      request: CanonicalImageRequest,
      ctx: AdapterInvokeContext,
    ): Promise<CanonicalImageResult> {
      const base = ctx.baseUrl ?? DEFAULT_BASE;
      const url = `${base.replace(/\/$/, "")}/v1/image_generation`;
      const extra = (request.providerOptions?.minimaxi ?? {}) as Record<
        string,
        unknown
      >;
      const fmt =
        request.responseFormat === "b64_json" ? "base64" : "url";
      const body: Record<string, unknown> = {
        model: request.modelId,
        prompt: request.prompt,
        n: request.n ?? 1,
        response_format: fmt,
        ...extra,
      };
      if (request.size !== undefined) body.aspect_ratio = request.size;
      if (request.quality !== undefined) body.quality = request.quality;
      const { signal, dispose } = withOptionalTimeout(
        ctx.abortSignal,
        ctx.timeoutMs,
      );
      try {
        const res = await ctx.fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ctx.apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        });
        const json = (await readJsonOrText(res)) as Record<string, unknown>;
        if (!res.ok) {
          assertMiniMaxBaseResp(
            json.base_resp as { status_code?: unknown } | undefined,
            request.modelId,
          );
          throw new LLMError({
            code: "PROVIDER_ERROR",
            message: String(json),
            retryable: true,
            vendor: VENDOR,
            modelId: request.modelId,
          });
        }
        assertMiniMaxBaseResp(
          json.base_resp as { status_code?: unknown } | undefined,
          request.modelId,
        );
        const data = json.data as Record<string, unknown> | undefined;
        const urls = data?.image_urls as string[] | undefined;
        const b64s = data?.image_base64 as string[] | undefined;
        const images =
          urls?.map((u) => ({ url: u })) ??
          b64s?.map((b) => ({ b64Json: b })) ??
          [];
        return { images, raw: json };
      } catch (e) {
        fetchError(e, request.modelId);
      } finally {
        dispose();
      }
    },

    async textToSpeech(
      request: CanonicalSpeechRequest,
      ctx: AdapterInvokeContext,
    ): Promise<CanonicalSpeechResult> {
      const base = ctx.baseUrl ?? DEFAULT_BASE;
      const url = `${base.replace(/\/$/, "")}/v1/t2a_v2`;
      const extra = (request.providerOptions?.minimaxi ?? {}) as Record<
        string,
        unknown
      >;
      const voiceId =
        request.voice ??
        (typeof extra.default_voice_id === "string"
          ? extra.default_voice_id
          : "male-qn-qingse");
      const audioFormat = request.format ?? "mp3";
      const body: Record<string, unknown> = {
        model: request.modelId,
        text: request.text,
        stream: false,
        voice_setting: {
          voice_id: voiceId,
          speed: request.speed ?? 1,
          vol: 1,
          pitch: 0,
          ...(typeof extra.voice_setting === "object" &&
          extra.voice_setting !== null
            ? (extra.voice_setting as object)
            : {}),
        },
        audio_setting: {
          format: audioFormat,
          sample_rate: 32000,
          bitrate: 128000,
          channel: 1,
          ...(typeof extra.audio_setting === "object" &&
          extra.audio_setting !== null
            ? (extra.audio_setting as object)
            : {}),
        },
        ...Object.fromEntries(
          Object.entries(extra).filter(
            ([k]) =>
              !["default_voice_id", "voice_setting", "audio_setting"].includes(
                k,
              ),
          ),
        ),
      };
      const { signal, dispose } = withOptionalTimeout(
        ctx.abortSignal,
        ctx.timeoutMs,
      );
      try {
        const res = await ctx.fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ctx.apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        });
        const json = (await res.json()) as Record<string, unknown>;
        if (!res.ok) {
          assertMiniMaxBaseResp(
            json.base_resp as { status_code?: unknown } | undefined,
            request.modelId,
          );
          throw new LLMError({
            code: "PROVIDER_ERROR",
            message: JSON.stringify(json),
            retryable: true,
            vendor: VENDOR,
            modelId: request.modelId,
          });
        }
        assertMiniMaxBaseResp(
          json.base_resp as { status_code?: unknown } | undefined,
          request.modelId,
        );
        const data = json.data as Record<string, unknown> | undefined;
        const audioHex = data?.audio;
        if (typeof audioHex !== "string") {
          throw new LLMError({
            code: "INVALID_RESPONSE",
            message: "MiniMax T2A response missing data.audio hex",
            retryable: false,
            vendor: VENDOR,
            modelId: request.modelId,
          });
        }
        const audio = hexToBytes(audioHex, request.modelId);
        const extraInfo = json.extra_info as Record<string, unknown> | undefined;
        const contentType =
          typeof extraInfo?.audio_format === "string"
            ? `audio/${extraInfo.audio_format}`
            : `audio/${audioFormat}`;
        return { audio, contentType, raw: json };
      } catch (e) {
        fetchError(e, request.modelId);
      } finally {
        dispose();
      }
    },

    async generateVideo(
      request: CanonicalVideoRequest,
      ctx: AdapterInvokeContext,
    ): Promise<CanonicalVideoResult> {
      const base = ctx.baseUrl ?? DEFAULT_BASE;
      const url = `${base.replace(/\/$/, "")}/v1/video_generation`;
      const extra = (request.providerOptions?.minimaxi ?? {}) as Record<
        string,
        unknown
      >;
      const body: Record<string, unknown> = {
        model: request.modelId,
        prompt: request.prompt,
        ...extra,
      };
      if (request.seconds !== undefined) body.duration = request.seconds;
      if (request.size !== undefined) body.resolution = request.size;
      const { signal, dispose } = withOptionalTimeout(
        ctx.abortSignal,
        ctx.timeoutMs,
      );
      try {
        const res = await ctx.fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ctx.apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        });
        const json = (await res.json()) as Record<string, unknown>;
        if (!res.ok) {
          assertMiniMaxBaseResp(
            json.base_resp as { status_code?: unknown } | undefined,
            request.modelId,
          );
          throw new LLMError({
            code: "PROVIDER_ERROR",
            message: JSON.stringify(json),
            retryable: true,
            vendor: VENDOR,
            modelId: request.modelId,
          });
        }
        assertMiniMaxBaseResp(
          json.base_resp as { status_code?: unknown } | undefined,
          request.modelId,
        );
        const taskId = String(json.task_id ?? "");
        return {
          videoId: taskId,
          status: "queued",
          raw: json,
        };
      } catch (e) {
        fetchError(e, request.modelId);
      } finally {
        dispose();
      }
    },

    async getVideoJob(
      query: CanonicalVideoJobQuery,
      ctx: AdapterInvokeContext,
    ): Promise<CanonicalVideoJob> {
      const base = ctx.baseUrl ?? DEFAULT_BASE;
      const q = new URLSearchParams({ task_id: query.videoId });
      const url = `${base.replace(/\/$/, "")}/v1/query/video_generation?${q}`;
      const { signal, dispose } = withOptionalTimeout(
        ctx.abortSignal,
        ctx.timeoutMs,
      );
      try {
        const res = await ctx.fetch(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${ctx.apiKey}` },
          signal,
        });
        const json = (await res.json()) as Record<string, unknown>;
        if (!res.ok) {
          assertMiniMaxBaseResp(
            json.base_resp as { status_code?: unknown } | undefined,
            query.videoId,
          );
          throw new LLMError({
            code: "PROVIDER_ERROR",
            message: JSON.stringify(json),
            retryable: true,
            vendor: VENDOR,
            modelId: query.videoId,
          });
        }
        assertMiniMaxBaseResp(
          json.base_resp as { status_code?: unknown } | undefined,
          query.videoId,
        );
        const st = mapQueryStatus(String(json.status ?? "other"));
        const fid = json.file_id;
        return {
          videoId: String(json.task_id ?? query.videoId),
          status: st,
          error:
            st === "failed"
              ? String(
                  (json.base_resp as { status_msg?: string } | undefined)
                    ?.status_msg ?? "Fail",
                )
              : undefined,
          fileId: fid != null ? String(fid) : undefined,
          raw: json,
        };
      } catch (e) {
        fetchError(e, query.videoId);
      } finally {
        dispose();
      }
    },

    async downloadVideo(
      query: CanonicalVideoDownloadQuery,
      ctx: AdapterInvokeContext,
    ): Promise<CanonicalVideoContentResult> {
      if (!query.fileId) {
        throw new LLMError({
          code: "INVALID_REQUEST",
          message:
            "MiniMax video download requires fileId from getVideoJob after status completed",
          retryable: false,
          vendor: VENDOR,
          modelId: query.videoId ?? query.fileId,
        });
      }
      const base = ctx.baseUrl ?? DEFAULT_BASE;
      const q = new URLSearchParams({ file_id: query.fileId });
      const url = `${base.replace(/\/$/, "")}/v1/files/retrieve?${q}`;
      const { signal, dispose } = withOptionalTimeout(
        ctx.abortSignal,
        ctx.timeoutMs,
      );
      const modelId = query.videoId ?? query.fileId;
      try {
        const res = await ctx.fetch(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${ctx.apiKey}` },
          signal,
        });
        const json = (await res.json()) as Record<string, unknown>;
        if (!res.ok) {
          assertMiniMaxBaseResp(
            json.base_resp as { status_code?: unknown } | undefined,
            modelId,
          );
          throw new LLMError({
            code: "PROVIDER_ERROR",
            message: JSON.stringify(json),
            retryable: true,
            vendor: VENDOR,
            modelId,
          });
        }
        assertMiniMaxBaseResp(
          json.base_resp as { status_code?: unknown } | undefined,
          modelId,
        );
        const file = json.file as Record<string, unknown> | undefined;
        const downloadUrl = file?.download_url;
        if (typeof downloadUrl !== "string" || downloadUrl.length === 0) {
          throw new LLMError({
            code: "INVALID_RESPONSE",
            message: "MiniMax file retrieve missing download_url",
            retryable: false,
            vendor: VENDOR,
            modelId,
          });
        }
        const absolute =
          downloadUrl.startsWith("http://") ||
          downloadUrl.startsWith("https://")
            ? downloadUrl
            : `https://${downloadUrl.replace(/^\/\//, "")}`;
        const binRes = await ctx.fetch(absolute, {
          method: "GET",
          signal,
        });
        if (!binRes.ok) {
          throw new LLMError({
            code: "NETWORK",
            message: `Failed to download video: HTTP ${binRes.status}`,
            retryable: true,
            vendor: VENDOR,
            modelId,
          });
        }
        const data = new Uint8Array(await binRes.arrayBuffer());
        const contentType =
          binRes.headers.get("content-type") ?? "video/mp4";
        return { data, contentType };
      } catch (e) {
        fetchError(e, modelId);
      } finally {
        dispose();
      }
    },
  };
}

export function createMinimaxiAdapter(): LLMAdapter {
  const oa = createOpenAIAdapter();
  const mini = createMinimaxiMultimodalMethods();
  const patchCtx = (ctx: AdapterInvokeContext): AdapterInvokeContext => ({
    ...ctx,
    vendorId: VENDOR,
    baseUrl: ctx.baseUrl ?? DEFAULT_BASE,
  });
  return {
    vendorId: VENDOR,
    async generateText(request, ctx) {
      return oa.generateText(request, patchCtx(ctx));
    },
    async streamText(request, ctx) {
      return oa.streamText(request, patchCtx(ctx));
    },
    getCapabilities: oa.getCapabilities.bind(oa),
    mapError(error, c) {
      if (LLMError.isInstance(error) && error.vendor === VENDOR) {
        return error;
      }
      return relabelVendor(oa.mapError(error, c), VENDOR);
    },
    ...mini,
  };
}
