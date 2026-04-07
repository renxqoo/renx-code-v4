import { LLMError, RetryableError } from "./errors";
import type { AdapterInvokeContext } from "./adapter";
import { isFetchAbortError, withOptionalTimeout } from "./abort";
import { mapOpenAIHttpError } from "./openai-http-errors";
import type {
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
} from "./types";

const VENDOR = "openai";
const DEFAULT_BASE = "https://api.openai.com/v1";

function mapVideoStatus(s: string): CanonicalVideoResult["status"] {
  switch (s) {
    case "queued":
    case "in_progress":
    case "completed":
    case "failed":
      return s;
    default:
      return "other";
  }
}

function openaiFetchError(e: unknown, modelId: string): never {
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

export function createOpenAIMultimodalMethods() {
  return {
    async generateImage(
      request: CanonicalImageRequest,
      ctx: AdapterInvokeContext,
    ): Promise<CanonicalImageResult> {
      const base = ctx.baseUrl ?? DEFAULT_BASE;
      const url = `${base.replace(/\/$/, "")}/images/generations`;
      const extra = (request.providerOptions?.openai ?? {}) as Record<
        string,
        unknown
      >;
      const body: Record<string, unknown> = {
        model: request.modelId,
        prompt: request.prompt,
        n: request.n ?? 1,
        ...extra,
      };
      if (request.size !== undefined) body.size = request.size;
      if (request.quality !== undefined) body.quality = request.quality;
      if (request.responseFormat !== undefined) {
        body.response_format = request.responseFormat;
      }
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
        if (!res.ok) throw await mapOpenAIHttpError(res, request.modelId);
        const json = (await res.json()) as Record<string, unknown>;
        const data = json.data as Array<Record<string, unknown>> | undefined;
        const images =
          data?.map((item) => ({
            url: typeof item.url === "string" ? item.url : undefined,
            b64Json:
              typeof item.b64_json === "string" ? item.b64_json : undefined,
            revisedPrompt:
              typeof item.revised_prompt === "string"
                ? item.revised_prompt
                : undefined,
          })) ?? [];
        return { images, raw: json };
      } catch (e) {
        openaiFetchError(e, request.modelId);
      } finally {
        dispose();
      }
    },

    async textToSpeech(
      request: CanonicalSpeechRequest,
      ctx: AdapterInvokeContext,
    ): Promise<CanonicalSpeechResult> {
      const base = ctx.baseUrl ?? DEFAULT_BASE;
      const url = `${base.replace(/\/$/, "")}/audio/speech`;
      const extra = (request.providerOptions?.openai ?? {}) as Record<
        string,
        unknown
      >;
      const body: Record<string, unknown> = {
        model: request.modelId,
        input: request.text,
        ...extra,
      };
      if (request.voice !== undefined) body.voice = request.voice;
      if (request.format !== undefined) body.response_format = request.format;
      if (request.speed !== undefined) body.speed = request.speed;
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
        if (!res.ok) throw await mapOpenAIHttpError(res, request.modelId);
        const buf = new Uint8Array(await res.arrayBuffer());
        const contentType = res.headers.get("content-type") ?? undefined;
        return { audio: buf, contentType, raw: undefined };
      } catch (e) {
        openaiFetchError(e, request.modelId);
      } finally {
        dispose();
      }
    },

    async transcribe(
      request: CanonicalTranscriptionRequest,
      ctx: AdapterInvokeContext,
    ): Promise<CanonicalTranscriptionResult> {
      const base = ctx.baseUrl ?? DEFAULT_BASE;
      const url = `${base.replace(/\/$/, "")}/audio/transcriptions`;
      const form = new FormData();
      const audioCopy = new Uint8Array(request.audio);
      form.append(
        "file",
        new Blob([audioCopy]),
        request.filename ?? "audio.mp3",
      );
      form.append("model", request.modelId);
      const extra = (request.providerOptions?.openai ?? {}) as Record<
        string,
        unknown
      >;
      for (const [k, v] of Object.entries(extra)) {
        if (v != null) form.append(k, String(v));
      }
      if (request.language !== undefined) {
        form.append("language", request.language);
      }
      if (request.prompt !== undefined) form.append("prompt", request.prompt);
      if (request.responseFormat !== undefined) {
        form.append("response_format", request.responseFormat);
      }
      const { signal, dispose } = withOptionalTimeout(
        ctx.abortSignal,
        ctx.timeoutMs,
      );
      try {
        const res = await ctx.fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${ctx.apiKey}` },
          body: form,
          signal,
        });
        if (!res.ok) throw await mapOpenAIHttpError(res, request.modelId);
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
          language:
            typeof json.language === "string" ? json.language : undefined,
          durationSeconds:
            typeof json.duration === "number" ? json.duration : undefined,
          raw: json,
        };
      } catch (e) {
        openaiFetchError(e, request.modelId);
      } finally {
        dispose();
      }
    },

    async generateVideo(
      request: CanonicalVideoRequest,
      ctx: AdapterInvokeContext,
    ): Promise<CanonicalVideoResult> {
      const base = ctx.baseUrl ?? DEFAULT_BASE;
      const url = `${base.replace(/\/$/, "")}/videos`;
      const form = new FormData();
      form.append("prompt", request.prompt);
      form.append("model", request.modelId);
      if (request.size !== undefined) form.append("size", request.size);
      if (request.seconds !== undefined) {
        form.append("seconds", String(request.seconds));
      }
      const extra = (request.providerOptions?.openai ?? {}) as Record<
        string,
        unknown
      >;
      for (const [k, v] of Object.entries(extra)) {
        if (v != null && !(k in { prompt: 1, model: 1, size: 1, seconds: 1 })) {
          form.append(k, String(v));
        }
      }
      const { signal, dispose } = withOptionalTimeout(
        ctx.abortSignal,
        ctx.timeoutMs,
      );
      try {
        const res = await ctx.fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${ctx.apiKey}` },
          body: form,
          signal,
        });
        if (!res.ok) throw await mapOpenAIHttpError(res, request.modelId);
        const json = (await res.json()) as Record<string, unknown>;
        const id = String(json.id ?? "");
        const status = mapVideoStatus(String(json.status ?? "other"));
        const progress =
          typeof json.progress === "number" ? json.progress : undefined;
        return { videoId: id, status, progress, raw: json };
      } catch (e) {
        openaiFetchError(e, request.modelId);
      } finally {
        dispose();
      }
    },

    async getVideoJob(
      query: CanonicalVideoJobQuery,
      ctx: AdapterInvokeContext,
    ): Promise<CanonicalVideoJob> {
      const base = ctx.baseUrl ?? DEFAULT_BASE;
      const url = `${base.replace(/\/$/, "")}/videos/${encodeURIComponent(query.videoId)}`;
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
        if (!res.ok) throw await mapOpenAIHttpError(res, query.videoId);
        const json = (await res.json()) as Record<string, unknown>;
        const errObj = json.error as Record<string, unknown> | undefined;
        const errMsg =
          errObj && typeof errObj.message === "string"
            ? errObj.message
            : undefined;
        return {
          videoId: String(json.id ?? query.videoId),
          status: mapVideoStatus(String(json.status ?? "other")),
          progress:
            typeof json.progress === "number" ? json.progress : undefined,
          error: errMsg,
          raw: json,
        };
      } catch (e) {
        openaiFetchError(e, query.videoId);
      } finally {
        dispose();
      }
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
      const base = ctx.baseUrl ?? DEFAULT_BASE;
      const url = `${base.replace(/\/$/, "")}/videos/${encodeURIComponent(query.videoId)}/content`;
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
        if (!res.ok) throw await mapOpenAIHttpError(res, query.videoId);
        const data = new Uint8Array(await res.arrayBuffer());
        const contentType = res.headers.get("content-type") ?? undefined;
        return { data, contentType };
      } catch (e) {
        openaiFetchError(e, query.videoId);
      } finally {
        dispose();
      }
    },
  };
}
