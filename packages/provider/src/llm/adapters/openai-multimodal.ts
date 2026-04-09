import { LLMError } from "../errors";
import type { AdapterInvokeContext } from "../adapter";
import { bearerAuthHeaders, withAdapterFetch } from "../adapter-request";
import { mapHttpError } from "./openai-http-errors";
import { assertNoReservedProviderOptions } from "../internal/provider-options";
import { createStatusMapper } from "../internal/video-status";
import type {
  AdapterEndpoints,
  CanonicalImageRequest,
  CanonicalImageResult,
  CanonicalSpeechRequest,
  CanonicalSpeechResult,
  CanonicalTranscriptionRequest,
  CanonicalTranscriptionResult,
  CanonicalVideoContentResult,
  CanonicalVideoJob,
  CanonicalVideoDownloadQuery,
  CanonicalVideoJobQuery,
  CanonicalVideoRequest,
  CanonicalVideoResult,
} from "../types";

const VENDOR = "openai";

export const OPENAI_MULTIMODAL_PATHS: AdapterEndpoints = {
  imageGenerations: "v1/images/generations",
  audioSpeech: "v1/audio/speech",
  audioTranscriptions: "v1/audio/transcriptions",
  videos: "v1/videos",
};

function resolvePath(ctx: AdapterInvokeContext, key: keyof AdapterEndpoints): string {
  const custom = ctx.paths?.[key];
  if (custom) return custom;
  return OPENAI_MULTIMODAL_PATHS[key] ?? OPENAI_MULTIMODAL_PATHS[key]!;
}

const mapVideoStatus = createStatusMapper({
  queued: "queued",
  in_progress: "in_progress",
  completed: "completed",
  failed: "failed",
});

function patchCtx(ctx: AdapterInvokeContext, defaultBase: string): AdapterInvokeContext {
  return { ...ctx, baseUrl: ctx.baseUrl ?? defaultBase };
}

export function createOpenAIMultimodalMethods(defaultBase: string) {
  return {
    async generateImage(
      request: CanonicalImageRequest,
      ctx: AdapterInvokeContext,
    ): Promise<CanonicalImageResult> {
      ctx = patchCtx(ctx, defaultBase);
      const extra = request.providerOptions ?? {};
      assertNoReservedProviderOptions(VENDOR, request.modelId, extra, [
        "apiKey",
        "model",
        "prompt",
        "n",
        "size",
        "quality",
        "response_format",
      ]);
      const body: Record<string, unknown> = {
        model: request.modelId,
        prompt: request.prompt,
        n: request.n ?? 1,
        ...extra,
      };
      if (request.size !== undefined) body.size = request.size;
      if (request.quality !== undefined) body.quality = request.quality;
      if (request.responseFormat !== undefined) body.response_format = request.responseFormat;

      return withAdapterFetch(
        ctx,
        resolvePath(ctx, "imageGenerations"),
        { authHeaders: bearerAuthHeaders(ctx.apiKey), json: body, modelId: request.modelId },
        async (res) => {
          if (!res.ok) throw await mapHttpError(res, request.modelId, VENDOR);
          const json = (await res.json()) as Record<string, unknown>;
          const data = json.data as Array<Record<string, unknown>> | undefined;
          const images =
            data?.map((item) => ({
              url: typeof item.url === "string" ? item.url : undefined,
              b64Json: typeof item.b64_json === "string" ? item.b64_json : undefined,
              revisedPrompt:
                typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
            })) ?? [];
          return { images, raw: json };
        },
      );
    },

    async textToSpeech(
      request: CanonicalSpeechRequest,
      ctx: AdapterInvokeContext,
    ): Promise<CanonicalSpeechResult> {
      ctx = patchCtx(ctx, defaultBase);
      const extra = request.providerOptions ?? {};
      assertNoReservedProviderOptions(VENDOR, request.modelId, extra, [
        "apiKey",
        "model",
        "input",
        "voice",
        "response_format",
        "speed",
      ]);
      const body: Record<string, unknown> = {
        model: request.modelId,
        input: request.text,
        ...extra,
      };
      if (request.voice !== undefined) body.voice = request.voice;
      if (request.format !== undefined) body.response_format = request.format;
      if (request.speed !== undefined) body.speed = request.speed;

      return withAdapterFetch(
        ctx,
        resolvePath(ctx, "audioSpeech"),
        { authHeaders: bearerAuthHeaders(ctx.apiKey), json: body, modelId: request.modelId },
        async (res) => {
          if (!res.ok) throw await mapHttpError(res, request.modelId, VENDOR);
          const buf = new Uint8Array(await res.arrayBuffer());
          const contentType = res.headers.get("content-type") ?? undefined;
          return { audio: buf, contentType, raw: undefined };
        },
      );
    },

    async transcribe(
      request: CanonicalTranscriptionRequest,
      ctx: AdapterInvokeContext,
    ): Promise<CanonicalTranscriptionResult> {
      ctx = patchCtx(ctx, defaultBase);
      assertNoReservedProviderOptions(VENDOR, request.modelId, request.providerOptions, [
        "apiKey",
        "file",
        "model",
        "language",
        "prompt",
        "response_format",
      ]);
      const form = new FormData();
      const audioCopy = new Uint8Array(request.audio);
      form.append("file", new Blob([audioCopy]), request.filename ?? "audio.mp3");
      form.append("model", request.modelId);
      if (request.language !== undefined) form.append("language", request.language);
      if (request.prompt !== undefined) form.append("prompt", request.prompt);
      if (request.responseFormat !== undefined)
        form.append("response_format", request.responseFormat);
      const extra = request.providerOptions ?? {};
      for (const [k, v] of Object.entries(extra)) {
        if (v != null && !form.has(k)) form.append(k, String(v));
      }

      return withAdapterFetch(
        ctx,
        resolvePath(ctx, "audioTranscriptions"),
        { authHeaders: bearerAuthHeaders(ctx.apiKey), body: form, modelId: request.modelId },
        async (res) => {
          if (!res.ok) throw await mapHttpError(res, request.modelId, VENDOR);
          const rf = request.responseFormat ?? "json";
          if (rf === "text" || rf === "vtt" || rf === "srt") {
            const text = await res.text();
            return { text, raw: text };
          }
          const json = (await res.json()) as Record<string, unknown>;
          const text = String(json.text ?? "");
          const segments = Array.isArray(json.segments)
            ? (json.segments as Array<Record<string, unknown>>).map((s) => ({
                start: Number(s.start) || 0,
                end: Number(s.end) || 0,
                text: String(s.text ?? ""),
              }))
            : undefined;
          return {
            text,
            segments,
            language: typeof json.language === "string" ? json.language : undefined,
            durationSeconds: typeof json.duration === "number" ? json.duration : undefined,
            raw: json,
          };
        },
      );
    },

    async generateVideo(
      request: CanonicalVideoRequest,
      ctx: AdapterInvokeContext,
    ): Promise<CanonicalVideoResult> {
      ctx = patchCtx(ctx, defaultBase);
      assertNoReservedProviderOptions(VENDOR, request.modelId, request.providerOptions, [
        "apiKey",
        "prompt",
        "model",
        "size",
        "seconds",
      ]);
      const form = new FormData();
      form.append("prompt", request.prompt);
      form.append("model", request.modelId);
      if (request.size !== undefined) form.append("size", request.size);
      if (request.seconds !== undefined) form.append("seconds", String(request.seconds));
      const reserved = new Set(["prompt", "model", "size", "seconds"]);
      const extra = request.providerOptions ?? {};
      for (const [k, v] of Object.entries(extra)) {
        if (v != null && !reserved.has(k)) {
          form.append(k, String(v));
        }
      }

      return withAdapterFetch(
        ctx,
        resolvePath(ctx, "videos"),
        { authHeaders: bearerAuthHeaders(ctx.apiKey), body: form, modelId: request.modelId },
        async (res) => {
          if (!res.ok) throw await mapHttpError(res, request.modelId, VENDOR);
          const json = (await res.json()) as Record<string, unknown>;
          const id = String(json.id ?? "");
          const status = mapVideoStatus(String(json.status ?? "other"));
          const progress = typeof json.progress === "number" ? json.progress : undefined;
          return { videoId: id, status, progress, raw: json };
        },
      );
    },

    async getVideoJob(
      query: CanonicalVideoJobQuery,
      ctx: AdapterInvokeContext,
    ): Promise<CanonicalVideoJob> {
      ctx = patchCtx(ctx, defaultBase);
      const basePath = resolvePath(ctx, "videos");
      return withAdapterFetch(
        ctx,
        `${basePath}/${encodeURIComponent(query.videoId)}`,
        { authHeaders: bearerAuthHeaders(ctx.apiKey), method: "GET", modelId: query.videoId },
        async (res) => {
          if (!res.ok) throw await mapHttpError(res, query.videoId, VENDOR);
          const json = (await res.json()) as Record<string, unknown>;
          const errObj = json.error as Record<string, unknown> | undefined;
          const errMsg = errObj && typeof errObj.message === "string" ? errObj.message : undefined;
          return {
            videoId: String(json.id ?? query.videoId),
            status: mapVideoStatus(String(json.status ?? "other")),
            progress: typeof json.progress === "number" ? json.progress : undefined,
            error: errMsg,
            raw: json,
          };
        },
      );
    },

    async downloadVideo(
      query: CanonicalVideoDownloadQuery,
      ctx: AdapterInvokeContext,
    ): Promise<CanonicalVideoContentResult> {
      if (!query.videoId) {
        throw new LLMError({
          code: "INVALID_REQUEST",
          message: "OpenAI video download requires videoId",
          retryable: false,
          vendor: VENDOR,
        });
      }

      ctx = patchCtx(ctx, defaultBase);
      const basePath = resolvePath(ctx, "videos");
      return withAdapterFetch(
        ctx,
        `${basePath}/${encodeURIComponent(query.videoId)}/content`,
        { authHeaders: bearerAuthHeaders(ctx.apiKey), method: "GET", modelId: query.videoId! },
        async (res) => {
          if (!res.ok) throw await mapHttpError(res, query.videoId!, VENDOR);
          const data = new Uint8Array(await res.arrayBuffer());
          const contentType = res.headers.get("content-type") ?? undefined;
          return { data, contentType };
        },
      );
    },
  };
}
