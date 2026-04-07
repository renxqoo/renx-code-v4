import { buildCanonicalRequest } from "./build-canonical-request";
import { LLMError } from "./errors";
import { normalizeModel } from "./model-ref";
import type { LLMRegistry } from "./registry";
import {
  defaultRetryPolicy,
  executeWithRetry,
  mergeRetryPolicy,
  type RetryPolicy,
} from "./retry";
import type { AdapterInvokeContext } from "./adapter";
import type {
  CanonicalFinishReason,
  CanonicalImageResult,
  CanonicalMessage,
  CanonicalSpeechResult,
  CanonicalStreamChunk,
  CanonicalTextResult,
  CanonicalTranscriptionResult,
  CanonicalUsage,
  CanonicalVideoContentResult,
  CanonicalVideoJob,
  CanonicalVideoResult,
  ModelHandle,
} from "./types";

/** Shared options for text and multimodal calls. */
export type ClientCallOptionsBase = {
  model: ModelHandle | string;
  abortSignal?: AbortSignal;
  providerOptions?: Record<string, unknown>;
  retry?: Partial<RetryPolicy> & { deadlineMs?: number };
  metadata?: Record<string, string | number | boolean | undefined>;
  timeoutMs?: number;
  includeRaw?: boolean;
};

export type GenerateTextOptions = ClientCallOptionsBase & {
  prompt?: string;
  messages?: CanonicalMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  stopSequences?: string[];
};

export type StreamTextOptions = GenerateTextOptions;

export type GenerateImageOptions = ClientCallOptionsBase & {
  prompt: string;
  n?: number;
  size?: string;
  quality?: string;
  responseFormat?: "url" | "b64_json";
};

export type TextToSpeechOptions = ClientCallOptionsBase & {
  text: string;
  voice?: string;
  format?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
  speed?: number;
};

export type TranscribeOptions = ClientCallOptionsBase & {
  audio: Uint8Array;
  filename?: string;
  language?: string;
  prompt?: string;
  responseFormat?: "json" | "text" | "verbose_json" | "vtt" | "srt";
};

export type GenerateVideoOptions = ClientCallOptionsBase & {
  prompt: string;
  size?: string;
  seconds?: number;
};

export type VideoJobCallOptions = ClientCallOptionsBase & {
  videoId: string;
};

/** Pass `videoId` for OpenAI; for MiniMax pass `fileId` from `getVideoJob` after status `completed`. */
export type DownloadVideoOptions = ClientCallOptionsBase & {
  videoId?: string;
  fileId?: string;
};

export type StreamTextResult = {
  textStream: AsyncIterable<CanonicalStreamChunk>;
  text: Promise<string>;
  usage: Promise<CanonicalUsage | undefined>;
  finishReason: Promise<CanonicalFinishReason>;
};

export type LLMRequestMode =
  | "generate"
  | "stream"
  | "image"
  | "speech"
  | "transcribe"
  | "video"
  | "video_job"
  | "video_download";

export type LLMHooks = {
  onRequestStart?: (info: {
    vendorId: string;
    modelId: string;
    mode: LLMRequestMode;
    metadata?: ClientCallOptionsBase["metadata"];
  }) => void;
  onRequestEnd?: (info: {
    vendorId: string;
    modelId: string;
    mode: LLMRequestMode;
    ok: boolean;
    latencyMs: number;
    error?: unknown;
  }) => void;
  onRetry?: (info: {
    vendorId: string;
    modelId: string;
    attempt: number;
    error: unknown;
  }) => void;
  onWarning?: (info: {
    vendorId: string;
    modelId: string;
    message: string;
  }) => void;
  onStreamChunk?: (info: { chunk: CanonicalStreamChunk }) => void | Promise<void>;
};

export type LLMClientConfig = {
  registry: LLMRegistry;
  resolveApiKey: (vendorId: string) => string | undefined;
  fetch?: typeof fetch;
  defaultRetry?: Partial<RetryPolicy>;
  defaultTimeoutMs?: number;
  strictParams?: boolean;
  hooks?: LLMHooks;
  shouldRetry?: (error: LLMError) => boolean;
  baseUrlByVendor?: Record<string, string>;
};

export type LLMClient = {
  generateText(options: GenerateTextOptions): Promise<CanonicalTextResult>;
  streamText(options: StreamTextOptions): Promise<StreamTextResult>;
  generateImage(options: GenerateImageOptions): Promise<CanonicalImageResult>;
  textToSpeech(options: TextToSpeechOptions): Promise<CanonicalSpeechResult>;
  transcribe(options: TranscribeOptions): Promise<CanonicalTranscriptionResult>;
  generateVideo(options: GenerateVideoOptions): Promise<CanonicalVideoResult>;
  getVideoJob(options: VideoJobCallOptions): Promise<CanonicalVideoJob>;
  downloadVideo(options: DownloadVideoOptions): Promise<CanonicalVideoContentResult>;
};

function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function mergeCallRetry(
  base: RetryPolicy,
  opts: { retry?: Partial<RetryPolicy> & { deadlineMs?: number } },
): RetryPolicy {
  if (!opts.retry) return base;
  const { deadlineMs: _deadline, ...partial } = opts.retry;
  return mergeRetryPolicy(base, partial);
}

function notImplemented(
  vendorId: string,
  capability: string,
  modelId: string,
): LLMError {
  return new LLMError({
    code: "NOT_IMPLEMENTED",
    message: `${capability} is not implemented for vendor: ${vendorId}`,
    retryable: false,
    vendor: vendorId,
    modelId,
  });
}

export function createLLMClient(config: LLMClientConfig): LLMClient {
  const fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  const policyBase = mergeRetryPolicy(defaultRetryPolicy, config.defaultRetry);
  const shouldRetryFn = config.shouldRetry ?? ((e: LLMError) => e.retryable);

  const resolveKey = (vendorId: string): string => {
    const k = config.resolveApiKey(vendorId);
    if (!k) {
      throw new LLMError({
        code: "UNAUTHORIZED",
        message: `Missing API key for vendor: ${vendorId}`,
        retryable: false,
        vendor: vendorId,
      });
    }
    return k;
  };

  const buildCtx = (
    vendorId: string,
    modelId: string,
    opts: ClientCallOptionsBase,
  ): AdapterInvokeContext => ({
    fetch: fetchImpl,
    apiKey: resolveKey(vendorId),
    baseUrl: config.baseUrlByVendor?.[vendorId],
    abortSignal: opts.abortSignal,
    timeoutMs: opts.timeoutMs ?? config.defaultTimeoutMs,
    vendorId,
    strictParams: config.strictParams,
    onWarning: (message) =>
      config.hooks?.onWarning?.({ vendorId, modelId, message }),
  });

  const isRetryable = (e: unknown): boolean => {
    if (!LLMError.isInstance(e)) return false;
    return shouldRetryFn(e);
  };

  async function generateText(
    opts: GenerateTextOptions,
  ): Promise<CanonicalTextResult> {
    const handle = normalizeModel(opts.model);
    const req = buildCanonicalRequest({ handle, ...opts });
    const adapter = config.registry.get(handle.vendorId);
    const ctx = buildCtx(handle.vendorId, handle.modelId, opts);
    const policy = mergeCallRetry(policyBase, opts);
    const t0 = nowMs();
    config.hooks?.onRequestStart?.({
      vendorId: handle.vendorId,
      modelId: handle.modelId,
      mode: "generate",
      metadata: opts.metadata,
    });
    try {
      const result = await executeWithRetry<CanonicalTextResult>(
        () => adapter.generateText(req, ctx),
        {
          policy,
          abortSignal: opts.abortSignal,
          deadlineMs: opts.retry?.deadlineMs,
          isRetryable,
          onRetry: ({ attempt, error }) =>
            config.hooks?.onRetry?.({
              vendorId: handle.vendorId,
              modelId: handle.modelId,
              attempt,
              error,
            }),
        },
      );
      const out: CanonicalTextResult =
        opts.includeRaw === true
          ? result
          : {
              text: result.text,
              finishReason: result.finishReason,
              usage: result.usage,
            };
      config.hooks?.onRequestEnd?.({
        vendorId: handle.vendorId,
        modelId: handle.modelId,
        mode: "generate",
        ok: true,
        latencyMs: nowMs() - t0,
      });
      return out;
    } catch (e) {
      const err = LLMError.isInstance(e)
        ? e
        : adapter.mapError(e, { modelId: handle.modelId });
      config.hooks?.onRequestEnd?.({
        vendorId: handle.vendorId,
        modelId: handle.modelId,
        mode: "generate",
        ok: false,
        latencyMs: nowMs() - t0,
        error: err,
      });
      throw err;
    }
  }

  async function streamText(
    opts: StreamTextOptions,
  ): Promise<StreamTextResult> {
    const handle = normalizeModel(opts.model);
    const req = buildCanonicalRequest({ handle, ...opts });
    const adapter = config.registry.get(handle.vendorId);
    const ctx = buildCtx(handle.vendorId, handle.modelId, opts);
    const policy = mergeCallRetry(policyBase, opts);
    const t0 = nowMs();
    config.hooks?.onRequestStart?.({
      vendorId: handle.vendorId,
      modelId: handle.modelId,
      mode: "stream",
      metadata: opts.metadata,
    });

    let iterable: AsyncIterable<CanonicalStreamChunk>;
    try {
      iterable = await executeWithRetry<AsyncIterable<CanonicalStreamChunk>>(
        () => adapter.streamText(req, ctx),
        {
          policy,
          abortSignal: opts.abortSignal,
          deadlineMs: opts.retry?.deadlineMs,
          isRetryable,
          onRetry: ({ attempt, error }) =>
            config.hooks?.onRetry?.({
              vendorId: handle.vendorId,
              modelId: handle.modelId,
              attempt,
              error,
            }),
        },
      );
    } catch (e) {
      const err = LLMError.isInstance(e)
        ? e
        : adapter.mapError(e, { modelId: handle.modelId });
      config.hooks?.onRequestEnd?.({
        vendorId: handle.vendorId,
        modelId: handle.modelId,
        mode: "stream",
        ok: false,
        latencyMs: nowMs() - t0,
        error: err,
      });
      throw err;
    }

    let resolveText!: (v: string) => void;
    let rejectText!: (e: unknown) => void;
    const textP = new Promise<string>((resolve, reject) => {
      resolveText = resolve;
      rejectText = reject;
    });
    let resolveUsage!: (v: CanonicalUsage | undefined) => void;
    const usageP = new Promise<CanonicalUsage | undefined>((resolve) => {
      resolveUsage = resolve;
    });
    let resolveFinish!: (v: CanonicalFinishReason) => void;
    const finishP = new Promise<CanonicalFinishReason>((resolve) => {
      resolveFinish = resolve;
    });

    async function* wrapped(): AsyncGenerator<CanonicalStreamChunk> {
      let acc = "";
      let lastUsage: CanonicalUsage | undefined;
      let lastFinish: CanonicalFinishReason = "other";
      try {
        for await (const c of iterable) {
          await Promise.resolve(
            config.hooks?.onStreamChunk?.({ chunk: c }),
          );
          if (c.type === "text-delta") acc += c.textDelta;
          if (c.type === "finish") {
            lastFinish = c.finishReason;
            lastUsage = c.usage ?? lastUsage;
          }
          yield c;
        }
        resolveText(acc);
        resolveUsage(lastUsage);
        resolveFinish(lastFinish);
        config.hooks?.onRequestEnd?.({
          vendorId: handle.vendorId,
          modelId: handle.modelId,
          mode: "stream",
          ok: true,
          latencyMs: nowMs() - t0,
        });
      } catch (e) {
        const err = LLMError.isInstance(e)
          ? e
          : adapter.mapError(e, { modelId: handle.modelId });
        rejectText(err);
        resolveUsage(undefined);
        resolveFinish("error");
        config.hooks?.onRequestEnd?.({
          vendorId: handle.vendorId,
          modelId: handle.modelId,
          mode: "stream",
          ok: false,
          latencyMs: nowMs() - t0,
          error: err,
        });
        throw err;
      }
    }

    return {
      textStream: wrapped(),
      text: textP,
      usage: usageP,
      finishReason: finishP,
    };
  }

  async function generateImage(
    opts: GenerateImageOptions,
  ): Promise<CanonicalImageResult> {
    const handle = normalizeModel(opts.model);
    const adapter = config.registry.get(handle.vendorId);
    const fn = adapter.generateImage;
    if (!fn) {
      throw notImplemented(handle.vendorId, "Image generation", handle.modelId);
    }
    const ctx = buildCtx(handle.vendorId, handle.modelId, opts);
    const policy = mergeCallRetry(policyBase, opts);
    const t0 = nowMs();
    config.hooks?.onRequestStart?.({
      vendorId: handle.vendorId,
      modelId: handle.modelId,
      mode: "image",
      metadata: opts.metadata,
    });
    try {
      const result = await executeWithRetry(
        () =>
          fn(
            {
              modelId: handle.modelId,
              prompt: opts.prompt,
              n: opts.n,
              size: opts.size,
              quality: opts.quality,
              responseFormat: opts.responseFormat,
              providerOptions: {
                ...handle.providerOptions,
                ...opts.providerOptions,
              },
            },
            ctx,
          ),
        {
          policy,
          abortSignal: opts.abortSignal,
          deadlineMs: opts.retry?.deadlineMs,
          isRetryable,
          onRetry: ({ attempt, error }) =>
            config.hooks?.onRetry?.({
              vendorId: handle.vendorId,
              modelId: handle.modelId,
              attempt,
              error,
            }),
        },
      );
      const out: CanonicalImageResult =
        opts.includeRaw === true
          ? result
          : { images: result.images };
      config.hooks?.onRequestEnd?.({
        vendorId: handle.vendorId,
        modelId: handle.modelId,
        mode: "image",
        ok: true,
        latencyMs: nowMs() - t0,
      });
      return out;
    } catch (e) {
      const err = LLMError.isInstance(e)
        ? e
        : adapter.mapError(e, { modelId: handle.modelId });
      config.hooks?.onRequestEnd?.({
        vendorId: handle.vendorId,
        modelId: handle.modelId,
        mode: "image",
        ok: false,
        latencyMs: nowMs() - t0,
        error: err,
      });
      throw err;
    }
  }

  async function textToSpeech(
    opts: TextToSpeechOptions,
  ): Promise<CanonicalSpeechResult> {
    const handle = normalizeModel(opts.model);
    const adapter = config.registry.get(handle.vendorId);
    const fn = adapter.textToSpeech;
    if (!fn) {
      throw notImplemented(handle.vendorId, "Text-to-speech", handle.modelId);
    }
    const ctx = buildCtx(handle.vendorId, handle.modelId, opts);
    const policy = mergeCallRetry(policyBase, opts);
    const t0 = nowMs();
    config.hooks?.onRequestStart?.({
      vendorId: handle.vendorId,
      modelId: handle.modelId,
      mode: "speech",
      metadata: opts.metadata,
    });
    try {
      const result = await executeWithRetry(
        () =>
          fn(
            {
              modelId: handle.modelId,
              text: opts.text,
              voice: opts.voice,
              format: opts.format,
              speed: opts.speed,
              providerOptions: {
                ...handle.providerOptions,
                ...opts.providerOptions,
              },
            },
            ctx,
          ),
        {
          policy,
          abortSignal: opts.abortSignal,
          deadlineMs: opts.retry?.deadlineMs,
          isRetryable,
          onRetry: ({ attempt, error }) =>
            config.hooks?.onRetry?.({
              vendorId: handle.vendorId,
              modelId: handle.modelId,
              attempt,
              error,
            }),
        },
      );
      const out: CanonicalSpeechResult =
        opts.includeRaw === true ? result : { audio: result.audio, contentType: result.contentType };
      config.hooks?.onRequestEnd?.({
        vendorId: handle.vendorId,
        modelId: handle.modelId,
        mode: "speech",
        ok: true,
        latencyMs: nowMs() - t0,
      });
      return out;
    } catch (e) {
      const err = LLMError.isInstance(e)
        ? e
        : adapter.mapError(e, { modelId: handle.modelId });
      config.hooks?.onRequestEnd?.({
        vendorId: handle.vendorId,
        modelId: handle.modelId,
        mode: "speech",
        ok: false,
        latencyMs: nowMs() - t0,
        error: err,
      });
      throw err;
    }
  }

  async function transcribe(
    opts: TranscribeOptions,
  ): Promise<CanonicalTranscriptionResult> {
    const handle = normalizeModel(opts.model);
    const adapter = config.registry.get(handle.vendorId);
    const fn = adapter.transcribe;
    if (!fn) {
      throw notImplemented(
        handle.vendorId,
        "Transcription",
        handle.modelId,
      );
    }
    const ctx = buildCtx(handle.vendorId, handle.modelId, opts);
    const policy = mergeCallRetry(policyBase, opts);
    const t0 = nowMs();
    config.hooks?.onRequestStart?.({
      vendorId: handle.vendorId,
      modelId: handle.modelId,
      mode: "transcribe",
      metadata: opts.metadata,
    });
    try {
      const result = await executeWithRetry(
        () =>
          fn(
            {
              modelId: handle.modelId,
              audio: opts.audio,
              filename: opts.filename,
              language: opts.language,
              prompt: opts.prompt,
              responseFormat: opts.responseFormat,
              providerOptions: {
                ...handle.providerOptions,
                ...opts.providerOptions,
              },
            },
            ctx,
          ),
        {
          policy,
          abortSignal: opts.abortSignal,
          deadlineMs: opts.retry?.deadlineMs,
          isRetryable,
          onRetry: ({ attempt, error }) =>
            config.hooks?.onRetry?.({
              vendorId: handle.vendorId,
              modelId: handle.modelId,
              attempt,
              error,
            }),
        },
      );
      const out: CanonicalTranscriptionResult =
        opts.includeRaw === true
          ? result
          : {
              text: result.text,
              segments: result.segments,
              language: result.language,
              durationSeconds: result.durationSeconds,
            };
      config.hooks?.onRequestEnd?.({
        vendorId: handle.vendorId,
        modelId: handle.modelId,
        mode: "transcribe",
        ok: true,
        latencyMs: nowMs() - t0,
      });
      return out;
    } catch (e) {
      const err = LLMError.isInstance(e)
        ? e
        : adapter.mapError(e, { modelId: handle.modelId });
      config.hooks?.onRequestEnd?.({
        vendorId: handle.vendorId,
        modelId: handle.modelId,
        mode: "transcribe",
        ok: false,
        latencyMs: nowMs() - t0,
        error: err,
      });
      throw err;
    }
  }

  async function generateVideo(
    opts: GenerateVideoOptions,
  ): Promise<CanonicalVideoResult> {
    const handle = normalizeModel(opts.model);
    const adapter = config.registry.get(handle.vendorId);
    const fn = adapter.generateVideo;
    if (!fn) {
      throw notImplemented(
        handle.vendorId,
        "Video generation",
        handle.modelId,
      );
    }
    const ctx = buildCtx(handle.vendorId, handle.modelId, opts);
    const policy = mergeCallRetry(policyBase, opts);
    const t0 = nowMs();
    config.hooks?.onRequestStart?.({
      vendorId: handle.vendorId,
      modelId: handle.modelId,
      mode: "video",
      metadata: opts.metadata,
    });
    try {
      const result = await executeWithRetry(
        () =>
          fn(
            {
              modelId: handle.modelId,
              prompt: opts.prompt,
              size: opts.size,
              seconds: opts.seconds,
              providerOptions: {
                ...handle.providerOptions,
                ...opts.providerOptions,
              },
            },
            ctx,
          ),
        {
          policy,
          abortSignal: opts.abortSignal,
          deadlineMs: opts.retry?.deadlineMs,
          isRetryable,
          onRetry: ({ attempt, error }) =>
            config.hooks?.onRetry?.({
              vendorId: handle.vendorId,
              modelId: handle.modelId,
              attempt,
              error,
            }),
        },
      );
      const out: CanonicalVideoResult =
        opts.includeRaw === true
          ? result
          : {
              videoId: result.videoId,
              status: result.status,
              progress: result.progress,
            };
      config.hooks?.onRequestEnd?.({
        vendorId: handle.vendorId,
        modelId: handle.modelId,
        mode: "video",
        ok: true,
        latencyMs: nowMs() - t0,
      });
      return out;
    } catch (e) {
      const err = LLMError.isInstance(e)
        ? e
        : adapter.mapError(e, { modelId: handle.modelId });
      config.hooks?.onRequestEnd?.({
        vendorId: handle.vendorId,
        modelId: handle.modelId,
        mode: "video",
        ok: false,
        latencyMs: nowMs() - t0,
        error: err,
      });
      throw err;
    }
  }

  async function getVideoJob(
    opts: VideoJobCallOptions,
  ): Promise<CanonicalVideoJob> {
    const handle = normalizeModel(opts.model);
    const adapter = config.registry.get(handle.vendorId);
    const fn = adapter.getVideoJob;
    if (!fn) {
      throw notImplemented(
        handle.vendorId,
        "Video job status",
        handle.modelId,
      );
    }
    const ctx = buildCtx(handle.vendorId, handle.modelId, opts);
    const policy = mergeCallRetry(policyBase, opts);
    const t0 = nowMs();
    config.hooks?.onRequestStart?.({
      vendorId: handle.vendorId,
      modelId: handle.modelId,
      mode: "video_job",
      metadata: opts.metadata,
    });
    try {
      const result = await executeWithRetry(
        () => fn({ videoId: opts.videoId }, ctx),
        {
          policy,
          abortSignal: opts.abortSignal,
          deadlineMs: opts.retry?.deadlineMs,
          isRetryable,
          onRetry: ({ attempt, error }) =>
            config.hooks?.onRetry?.({
              vendorId: handle.vendorId,
              modelId: handle.modelId,
              attempt,
              error,
            }),
        },
      );
      const out: CanonicalVideoJob =
        opts.includeRaw === true
          ? result
          : {
              videoId: result.videoId,
              status: result.status,
              progress: result.progress,
              error: result.error,
              fileId: result.fileId,
            };
      config.hooks?.onRequestEnd?.({
        vendorId: handle.vendorId,
        modelId: handle.modelId,
        mode: "video_job",
        ok: true,
        latencyMs: nowMs() - t0,
      });
      return out;
    } catch (e) {
      const err = LLMError.isInstance(e)
        ? e
        : adapter.mapError(e, { modelId: handle.modelId });
      config.hooks?.onRequestEnd?.({
        vendorId: handle.vendorId,
        modelId: handle.modelId,
        mode: "video_job",
        ok: false,
        latencyMs: nowMs() - t0,
        error: err,
      });
      throw err;
    }
  }

  async function downloadVideo(
    opts: DownloadVideoOptions,
  ): Promise<CanonicalVideoContentResult> {
    if (!opts.videoId && !opts.fileId) {
      throw new LLMError({
        code: "INVALID_REQUEST",
        message: "downloadVideo requires videoId (OpenAI) or fileId (MiniMax)",
        retryable: false,
      });
    }
    const handle = normalizeModel(opts.model);
    const adapter = config.registry.get(handle.vendorId);
    const fn = adapter.downloadVideo;
    if (!fn) {
      throw notImplemented(
        handle.vendorId,
        "Video download",
        handle.modelId,
      );
    }
    const ctx = buildCtx(handle.vendorId, handle.modelId, opts);
    const policy = mergeCallRetry(policyBase, opts);
    const t0 = nowMs();
    config.hooks?.onRequestStart?.({
      vendorId: handle.vendorId,
      modelId: handle.modelId,
      mode: "video_download",
      metadata: opts.metadata,
    });
    try {
      const result = await executeWithRetry(
        () => fn({ videoId: opts.videoId, fileId: opts.fileId }, ctx),
        {
          policy,
          abortSignal: opts.abortSignal,
          deadlineMs: opts.retry?.deadlineMs,
          isRetryable,
          onRetry: ({ attempt, error }) =>
            config.hooks?.onRetry?.({
              vendorId: handle.vendorId,
              modelId: handle.modelId,
              attempt,
              error,
            }),
        },
      );
      config.hooks?.onRequestEnd?.({
        vendorId: handle.vendorId,
        modelId: handle.modelId,
        mode: "video_download",
        ok: true,
        latencyMs: nowMs() - t0,
      });
      return result;
    } catch (e) {
      const err = LLMError.isInstance(e)
        ? e
        : adapter.mapError(e, { modelId: handle.modelId });
      config.hooks?.onRequestEnd?.({
        vendorId: handle.vendorId,
        modelId: handle.modelId,
        mode: "video_download",
        ok: false,
        latencyMs: nowMs() - t0,
        error: err,
      });
      throw err;
    }
  }

  return {
    generateText,
    streamText,
    generateImage,
    textToSpeech,
    transcribe,
    generateVideo,
    getVideoJob,
    downloadVideo,
  };
}
