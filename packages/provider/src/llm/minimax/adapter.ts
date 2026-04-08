import { LLMError, RetryableError } from "../errors";
import type { LLMAdapter, AdapterInvokeContext } from "../adapter";
import { createOpenAIAdapter } from "../adapters/openai-adapter";
import { withAdapterFetch } from "../adapter-request";
import { assertNoReservedProviderOptions } from "../internal/provider-options";
import { readJsonOrText, hexToBytes } from "../internal/util";
import { createStatusMapper } from "../internal/video-status";
import type {
  AdapterEndpoints,
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
import { MINIMAX_VENDOR_ID } from "./credentials";

const VENDOR = MINIMAX_VENDOR_ID;
/** @see https://platform.minimaxi.com/docs/api-reference/api-overview */
const DEFAULT_BASE = "https://api.minimaxi.com";

export const MINIMAX_DEFAULT_PATHS: AdapterEndpoints = {
  chatCompletions: "v1/chat/completions",
  imageGeneration: "v1/image_generation",
  textToAudio: "v1/t2a_v2",
  videoGeneration: "v1/video_generation",
  videoGenerationQuery: "v1/query/video_generation",
  fileRetrieve: "v1/files/retrieve",
};

function resolvePath(ctx: AdapterInvokeContext, key: keyof AdapterEndpoints): string {
  const custom = ctx.paths?.[key];
  if (custom) return custom;
  return MINIMAX_DEFAULT_PATHS[key]!;
}

// ── Vendor relabeling (delegation to OpenAI adapter) ────────────────────────

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

async function delegateWithVendorRelabel<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (LLMError.isInstance(e) && e.vendor !== VENDOR) {
      throw relabelVendor(e, VENDOR);
    }
    throw e;
  }
}

// ── MiniMax base_resp error mapping ─────────────────────────────────────────

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
    throw new RetryableError({ code: "RATE_LIMIT", message: msg, vendor: VENDOR, modelId });
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

/** Parse JSON, check base_resp, then check HTTP status. */
async function parseMiniMaxJson(res: Response, modelId: string): Promise<Record<string, unknown>> {
  const json = (await readJsonOrText(res)) as Record<string, unknown>;
  assertMiniMaxBaseResp(json.base_resp as { status_code?: unknown } | undefined, modelId);
  if (!res.ok) {
    throw new LLMError({
      code: "PROVIDER_ERROR",
      message: JSON.stringify(json),
      retryable: true,
      vendor: VENDOR,
      modelId,
    });
  }
  return json;
}

// ── Video status mapping ────────────────────────────────────────────────────

const mapQueryStatus = createStatusMapper({
  Preparing: "queued",
  Queueing: "queued",
  Processing: "in_progress",
  Success: "completed",
  Fail: "failed",
});

// ── Multimodal methods ──────────────────────────────────────────────────────

function createMinimaxMultimodalMethods() {
  return {
    async generateImage(
      request: CanonicalImageRequest,
      ctx: AdapterInvokeContext,
    ): Promise<CanonicalImageResult> {
      const extra = request.providerOptions ?? {};
      assertNoReservedProviderOptions(VENDOR, request.modelId, extra, [
        "apiKey",
        "model",
        "prompt",
        "n",
        "aspect_ratio",
        "quality",
        "response_format",
      ]);
      const fmt = request.responseFormat === "b64_json" ? "base64" : "url";
      const body: Record<string, unknown> = {
        model: request.modelId,
        prompt: request.prompt,
        n: request.n ?? 1,
        response_format: fmt,
        ...extra,
      };
      if (request.size !== undefined) body.aspect_ratio = request.size;
      if (request.quality !== undefined) body.quality = request.quality;

      return withAdapterFetch(
        ctx,
        resolvePath(ctx, "imageGeneration"),
        { json: body, modelId: request.modelId },
        async (res) => {
          const json = await parseMiniMaxJson(res, request.modelId);
          const data = json.data as Record<string, unknown> | undefined;
          const urls = data?.image_urls as string[] | undefined;
          const b64s = data?.image_base64 as string[] | undefined;
          const images = urls?.map((u) => ({ url: u })) ?? b64s?.map((b) => ({ b64Json: b })) ?? [];
          return { images, raw: json };
        },
      );
    },

    async textToSpeech(
      request: CanonicalSpeechRequest,
      ctx: AdapterInvokeContext,
    ): Promise<CanonicalSpeechResult> {
      const extra = request.providerOptions ?? {};
      assertNoReservedProviderOptions(VENDOR, request.modelId, extra, [
        "apiKey",
        "model",
        "text",
        "stream",
        "voice_setting",
        "audio_setting",
      ]);
      const voiceId =
        request.voice ??
        (typeof extra.default_voice_id === "string" ? extra.default_voice_id : "male-qn-qingse");
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
          ...(typeof extra.voice_setting === "object" && extra.voice_setting !== null
            ? (extra.voice_setting as object)
            : {}),
        },
        audio_setting: {
          format: audioFormat,
          sample_rate: 32000,
          bitrate: 128000,
          channel: 1,
          ...(typeof extra.audio_setting === "object" && extra.audio_setting !== null
            ? (extra.audio_setting as object)
            : {}),
        },
        ...Object.fromEntries(
          Object.entries(extra).filter(
            ([k]) => !["default_voice_id", "voice_setting", "audio_setting"].includes(k),
          ),
        ),
      };

      return withAdapterFetch(
        ctx,
        resolvePath(ctx, "textToAudio"),
        { json: body, modelId: request.modelId },
        async (res) => {
          const json = await parseMiniMaxJson(res, request.modelId);
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
          let audio: Uint8Array;
          try {
            audio = hexToBytes(audioHex);
          } catch {
            throw new LLMError({
              code: "INVALID_RESPONSE",
              message: "Invalid hex audio payload from MiniMax",
              retryable: false,
              vendor: VENDOR,
              modelId: request.modelId,
            });
          }
          const extraInfo = json.extra_info as Record<string, unknown> | undefined;
          const contentType =
            typeof extraInfo?.audio_format === "string"
              ? `audio/${extraInfo.audio_format}`
              : `audio/${audioFormat}`;
          return { audio, contentType, raw: json };
        },
      );
    },

    async generateVideo(
      request: CanonicalVideoRequest,
      ctx: AdapterInvokeContext,
    ): Promise<CanonicalVideoResult> {
      const extra = request.providerOptions ?? {};
      assertNoReservedProviderOptions(VENDOR, request.modelId, extra, [
        "apiKey",
        "model",
        "prompt",
        "duration",
        "resolution",
      ]);
      const body: Record<string, unknown> = {
        model: request.modelId,
        prompt: request.prompt,
        ...extra,
      };
      if (request.seconds !== undefined) body.duration = request.seconds;
      if (request.size !== undefined) body.resolution = request.size;

      return withAdapterFetch(
        ctx,
        resolvePath(ctx, "videoGeneration"),
        { json: body, modelId: request.modelId },
        async (res) => {
          const json = await parseMiniMaxJson(res, request.modelId);
          return { videoId: String(json.task_id ?? ""), status: "queued", raw: json };
        },
      );
    },

    async getVideoJob(
      query: CanonicalVideoJobQuery,
      ctx: AdapterInvokeContext,
    ): Promise<CanonicalVideoJob> {
      return withAdapterFetch(
        ctx,
        resolvePath(ctx, "videoGenerationQuery"),
        { method: "GET", params: { task_id: query.videoId }, modelId: query.videoId },
        async (res) => {
          const json = await parseMiniMaxJson(res, query.videoId);
          const st = mapQueryStatus(String(json.status ?? "other"));
          const fid = json.file_id;
          return {
            videoId: String(json.task_id ?? query.videoId),
            status: st,
            error:
              st === "failed"
                ? String(
                    (json.base_resp as { status_msg?: string } | undefined)?.status_msg ?? "Fail",
                  )
                : undefined,
            fileId: fid != null ? String(fid) : undefined,
            raw: json,
          };
        },
      );
    },

    async downloadVideo(
      query: CanonicalVideoDownloadQuery,
      ctx: AdapterInvokeContext,
    ): Promise<CanonicalVideoContentResult> {
      if (!query.fileId) {
        throw new LLMError({
          code: "INVALID_REQUEST",
          message: "MiniMax video download requires fileId from getVideoJob after status completed",
          retryable: false,
          vendor: VENDOR,
          modelId: query.videoId ?? query.fileId,
        });
      }
      const modelId = query.videoId ?? query.fileId;

      return withAdapterFetch(
        ctx,
        resolvePath(ctx, "fileRetrieve"),
        { method: "GET", params: { file_id: query.fileId }, modelId },
        async (res) => {
          const json = await parseMiniMaxJson(res, modelId);
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
            downloadUrl.startsWith("http://") || downloadUrl.startsWith("https://")
              ? downloadUrl
              : `https://${downloadUrl.replace(/^\/\//, "")}`;

          // Second fetch to download the actual binary — not wrapped in withAdapterFetch
          // because it goes to a CDN URL, not the MiniMax API.
          const binRes = await ctx.fetch(absolute, { method: "GET" });
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
          const contentType = binRes.headers.get("content-type") ?? "video/mp4";
          return { data, contentType };
        },
      );
    },
  };
}

// ── Public adapter factory ──────────────────────────────────────────────────

export function createMinimaxAdapter(): LLMAdapter {
  const oa = createOpenAIAdapter();
  const mini = createMinimaxMultimodalMethods();
  const patchCtx = (ctx: AdapterInvokeContext): AdapterInvokeContext => ({
    ...ctx,
    vendorId: VENDOR,
    baseUrl: ctx.baseUrl ?? DEFAULT_BASE,
  });
  return {
    vendorId: VENDOR,
    async generateText(request, ctx) {
      return delegateWithVendorRelabel(() => oa.generateText(request, patchCtx(ctx)));
    },
    async streamText(request, ctx) {
      return delegateWithVendorRelabel(() => oa.streamText(request, patchCtx(ctx)));
    },
    getCapabilities: oa.getCapabilities.bind(oa),
    mapError(error, c) {
      if (LLMError.isInstance(error) && error.vendor === VENDOR) return error;
      return relabelVendor(oa.mapError(error, c), VENDOR);
    },
    async generateImage(request, ctx) {
      return mini.generateImage(request, patchCtx(ctx));
    },
    async textToSpeech(request, ctx) {
      return mini.textToSpeech(request, patchCtx(ctx));
    },
    async generateVideo(request, ctx) {
      return mini.generateVideo(request, patchCtx(ctx));
    },
    async getVideoJob(query, ctx) {
      return mini.getVideoJob(query, patchCtx(ctx));
    },
    async downloadVideo(query, ctx) {
      return mini.downloadVideo(query, patchCtx(ctx));
    },
  };
}
