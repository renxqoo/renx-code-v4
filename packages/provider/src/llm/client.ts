import { buildCanonicalRequest } from "./build-canonical-request";
import { LLMError } from "./errors";
import { normalizeModel } from "./model-ref";
import type { LLMRegistry } from "./registry";
import { defaultRetryPolicy, executeWithRetry, mergeRetryPolicy, type RetryPolicy } from "./retry";
import type { AdapterInvokeContext } from "./adapter";
import type {
  CanonicalFinishReason,
  CanonicalImageResult,
  CanonicalMessage,
  CanonicalSpeechResult,
  CanonicalStreamChunk,
  CanonicalTextResult,
  CanonicalToolCall,
  CanonicalTranscriptionResult,
  CanonicalUsage,
  CanonicalVideoContentResult,
  CanonicalVideoJob,
  CanonicalVideoResult,
  CanonicalTool,
  MessagePart,
  ModelHandle,
  ToolChoice,
  AdapterEndpoints,
} from "./types";

export type ModelProvider = ModelHandle | string;
/** Shared options for text and multimodal calls. */
export type ClientCallOptionsBase = {
  model: ModelProvider;
  abortSignal?: AbortSignal;
  providerOptions?: Record<string, unknown>;
  retry?: Partial<RetryPolicy> & { deadlineMs?: number };
  metadata?: Record<string, string | number | boolean | undefined>;
  timeoutMs?: number;
  includeRaw?: boolean;
};

export type GenerateTextOptions = ClientCallOptionsBase & {
  /** 与 `messages` 中 `content` 相同模型；字符串等价于单段文本。 */
  prompt?: string | MessagePart[];
  messages?: CanonicalMessage[];
  /** Shortcut: prepend a system message. */
  systemPrompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  stopSequences?: string[];
  tools?: CanonicalTool[];
  toolChoice?: ToolChoice;
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
  reasoning: Promise<string>;
  toolCalls: Promise<CanonicalToolCall[]>;
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
  onRetry?: (info: { vendorId: string; modelId: string; attempt: number; error: unknown }) => void;
  onWarning?: (info: { vendorId: string; modelId: string; message: string }) => void;
  onStreamChunk?: (info: { chunk: CanonicalStreamChunk }) => void | Promise<void>;
};

export type LLMClientConfig = {
  registry: LLMRegistry;
  resolveApiKey: (vendorId: string) => string | undefined;
  fetch?: typeof fetch;
  /** 覆盖默认重试策略；默认见 `defaultRetryPolicy`（当前为单次请求、不重试）。 */
  defaultRetry?: Partial<RetryPolicy>;
  defaultTimeoutMs?: number;
  strictParams?: boolean;
  hooks?: LLMHooks;
  shouldRetry?: (error: LLMError) => boolean;
  baseUrlByVendor?: Record<string, string>;
  pathsByVendor?: Record<string, Partial<AdapterEndpoints>>;
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

function notImplemented(vendorId: string, capability: string, modelId: string): LLMError {
  return new LLMError({
    code: "NOT_IMPLEMENTED",
    message: `${capability} is not implemented for vendor: ${vendorId}`,
    retryable: false,
    vendor: vendorId,
    modelId,
  });
}

function assertStrictTextParams(
  strictParams: boolean | undefined,
  adapter: ReturnType<LLMRegistry["get"]>,
  handle: ModelHandle,
  opts: GenerateTextOptions | StreamTextOptions,
  mode?: "stream",
): void {
  if (!strictParams) return;

  const capabilities = adapter.getCapabilities(handle.modelId);
  if (mode === "stream" && !capabilities.streaming) {
    throw new LLMError({
      code: "INVALID_REQUEST",
      message: `${handle.vendorId}/${handle.modelId} does not support streaming`,
      retryable: false,
      vendor: handle.vendorId,
      modelId: handle.modelId,
    });
  }
  if (opts.topP !== undefined && !capabilities.supportsTopP) {
    throw new LLMError({
      code: "INVALID_REQUEST",
      message: `${handle.vendorId}/${handle.modelId} does not support topP`,
      retryable: false,
      vendor: handle.vendorId,
      modelId: handle.modelId,
    });
  }
  if (opts.stopSequences !== undefined && !capabilities.supportsStopSequences) {
    throw new LLMError({
      code: "INVALID_REQUEST",
      message: `${handle.vendorId}/${handle.modelId} does not support stopSequences`,
      retryable: false,
      vendor: handle.vendorId,
      modelId: handle.modelId,
    });
  }
  const range = capabilities.maxOutputTokens;
  if (
    range &&
    opts.maxOutputTokens !== undefined &&
    (opts.maxOutputTokens < range.min || opts.maxOutputTokens > range.max)
  ) {
    throw new LLMError({
      code: "INVALID_REQUEST",
      message: `${handle.vendorId}/${handle.modelId} maxOutputTokens must be between ${range.min} and ${range.max}`,
      retryable: false,
      vendor: handle.vendorId,
      modelId: handle.modelId,
    });
  }
}

function streamIdleTimeoutError(handle: ModelHandle, timeoutMs: number): LLMError {
  return new LLMError({
    code: "TIMEOUT",
    message: `${handle.vendorId}/${handle.modelId} stream idle timeout after ${timeoutMs}ms`,
    retryable: true,
    vendor: handle.vendorId,
    modelId: handle.modelId,
  });
}

function streamAbortError(handle: ModelHandle, reason: unknown): LLMError {
  return new LLMError({
    code: "ABORTED",
    message: "Request aborted",
    retryable: false,
    vendor: handle.vendorId,
    modelId: handle.modelId,
    cause: reason,
  });
}

async function nextStreamChunkWithTimeout<T>(
  iterator: AsyncIterator<T>,
  handle: ModelHandle,
  abortSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): Promise<IteratorResult<T>> {
  if (!abortSignal && (timeoutMs === undefined || timeoutMs <= 0)) {
    return iterator.next();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  try {
    if (abortSignal?.aborted) {
      throw streamAbortError(handle, abortSignal.reason);
    }

    const pending: Array<Promise<IteratorResult<T>>> = [iterator.next()];
    if (abortSignal) {
      pending.push(
        new Promise<IteratorResult<T>>((_, reject) => {
          const onAbort = (): void => reject(streamAbortError(handle, abortSignal.reason));
          abortSignal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => abortSignal.removeEventListener("abort", onAbort);
        }),
      );
    }
    if (timeoutMs !== undefined && timeoutMs > 0) {
      pending.push(
        new Promise<IteratorResult<T>>((_, reject) => {
          timer = setTimeout(() => reject(streamIdleTimeoutError(handle, timeoutMs)), timeoutMs);
        }),
      );
    }

    return await Promise.race(pending);
  } catch (error) {
    if (LLMError.isInstance(error) && (error.code === "TIMEOUT" || error.code === "ABORTED")) {
      try {
        await iterator.return?.();
      } catch {
        // Ignore best-effort cleanup failures; the timeout is the primary error.
      }
    }
    throw error;
  } finally {
    removeAbortListener?.();
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Strip `raw` field from a result when `includeRaw` is not set. */
function omitRaw<T>(result: T, includeRaw: boolean): T {
  if (includeRaw || !("raw" in (result as object))) return result;
  const { raw: _, ...rest } = result as object & { raw?: unknown };
  return rest as T;
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
    onWarning: (message) => config.hooks?.onWarning?.({ vendorId, modelId, message }),
    paths: config.pathsByVendor?.[vendorId] as Record<string, string> | undefined,
  });

  const isRetryable = (e: unknown): boolean => {
    if (!LLMError.isInstance(e)) return false;
    return shouldRetryFn(e);
  };

  // ── Shared invocation logic: resolve model → get adapter → retry → hooks → strip raw ──

  async function invokeAdapter<R>(
    mode: LLMRequestMode,
    opts: ClientCallOptionsBase,
    exec: (
      adapter: ReturnType<LLMRegistry["get"]>,
      handle: ModelHandle,
      ctx: AdapterInvokeContext,
    ) => Promise<R>,
  ): Promise<R> {
    const handle = normalizeModel(opts.model);
    const adapter = config.registry.get(handle.vendorId);
    const ctx = buildCtx(handle.vendorId, handle.modelId, opts);
    const policy = mergeCallRetry(policyBase, opts);
    const t0 = nowMs();

    config.hooks?.onRequestStart?.({
      vendorId: handle.vendorId,
      modelId: handle.modelId,
      mode,
      metadata: opts.metadata,
    });

    try {
      const result = await executeWithRetry<R>(() => exec(adapter, handle, ctx), {
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
      });

      const out = omitRaw(result, opts.includeRaw === true);

      config.hooks?.onRequestEnd?.({
        vendorId: handle.vendorId,
        modelId: handle.modelId,
        mode,
        ok: true,
        latencyMs: nowMs() - t0,
      });

      return out;
    } catch (e) {
      const err = LLMError.isInstance(e) ? e : adapter.mapError(e, { modelId: handle.modelId });
      config.hooks?.onRequestEnd?.({
        vendorId: handle.vendorId,
        modelId: handle.modelId,
        mode,
        ok: false,
        latencyMs: nowMs() - t0,
        error: err,
      });
      throw err;
    }
  }

  // ── Public methods ──

  function generateText(opts: GenerateTextOptions): Promise<CanonicalTextResult> {
    return invokeAdapter("generate", opts, (adapter, handle, ctx) => {
      assertStrictTextParams(config.strictParams, adapter, handle, opts);
      const req = buildCanonicalRequest({ handle, ...opts });
      return adapter.generateText(req, ctx);
    });
  }

  async function streamText(opts: StreamTextOptions): Promise<StreamTextResult> {
    const handle = normalizeModel(opts.model);
    const adapter = config.registry.get(handle.vendorId);
    assertStrictTextParams(config.strictParams, adapter, handle, opts, "stream");
    const req = buildCanonicalRequest({ handle, ...opts });
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
      const err = LLMError.isInstance(e) ? e : adapter.mapError(e, { modelId: handle.modelId });
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
    let resolveReasoning!: (v: string) => void;
    const reasoningP = new Promise<string>((resolve) => {
      resolveReasoning = resolve;
    });
    let resolveToolCalls!: (v: CanonicalToolCall[]) => void;
    const toolCallsP = new Promise<CanonicalToolCall[]>((resolve) => {
      resolveToolCalls = resolve;
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
      const iterator = iterable[Symbol.asyncIterator]();
      let acc = "";
      let reasoningAcc = "";
      const toolCallMap = new Map<number, CanonicalToolCall>();
      let lastUsage: CanonicalUsage | undefined;
      let lastFinish: CanonicalFinishReason = "other";
      let settled = false;
      let iteratorDone = false;
      try {
        while (true) {
          const step = await nextStreamChunkWithTimeout(
            iterator,
            handle,
            opts.abortSignal,
            opts.timeoutMs ?? config.defaultTimeoutMs,
          );
          if (step.done) {
            iteratorDone = true;
            break;
          }
          const c = step.value;
          await Promise.resolve(config.hooks?.onStreamChunk?.({ chunk: c }));
          if (c.type === "text-delta") acc += c.textDelta;
          if (c.type === "reasoning-delta") reasoningAcc += c.reasoningDelta;
          if (c.type === "tool-call-delta") {
            const existing = toolCallMap.get(c.index);
            if (existing) {
              if (c.argumentsDelta) existing.arguments += c.argumentsDelta;
            } else {
              toolCallMap.set(c.index, {
                id: c.id ?? "",
                name: c.name ?? "",
                arguments: c.argumentsDelta ?? "",
              });
            }
          }
          if (c.type === "finish") {
            lastFinish = c.finishReason;
            lastUsage = c.usage ?? lastUsage;
          }
          yield c;
        }
        const toolCallsArr = Array.from(toolCallMap.values());
        settled = true;
        resolveText(acc);
        resolveReasoning(reasoningAcc);
        resolveToolCalls(toolCallsArr);
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
        settled = true;
        const err = LLMError.isInstance(e) ? e : adapter.mapError(e, { modelId: handle.modelId });
        rejectText(err);
        resolveReasoning("");
        resolveToolCalls([]);
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
      } finally {
        if (!iteratorDone) {
          try {
            await iterator.return?.();
          } catch {
            // Preserve the original stream result/error; cleanup is best-effort.
          }
        }
        if (!settled) {
          // Consumer stopped early (break/return) — settle promises & fire hook.
          resolveText(acc);
          resolveReasoning(reasoningAcc);
          resolveToolCalls(Array.from(toolCallMap.values()));
          resolveUsage(lastUsage);
          resolveFinish(lastFinish);
          config.hooks?.onRequestEnd?.({
            vendorId: handle.vendorId,
            modelId: handle.modelId,
            mode: "stream",
            ok: true,
            latencyMs: nowMs() - t0,
          });
        }
      }
    }

    return {
      textStream: wrapped(),
      text: textP,
      reasoning: reasoningP,
      toolCalls: toolCallsP,
      usage: usageP,
      finishReason: finishP,
    };
  }

  function generateImage(opts: GenerateImageOptions): Promise<CanonicalImageResult> {
    return invokeAdapter("image", opts, (adapter, handle, ctx) => {
      const fn = adapter.generateImage;
      if (!fn) {
        throw notImplemented(handle.vendorId, "Image generation", handle.modelId);
      }
      return fn(
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
      );
    });
  }

  function textToSpeech(opts: TextToSpeechOptions): Promise<CanonicalSpeechResult> {
    return invokeAdapter("speech", opts, (adapter, handle, ctx) => {
      const fn = adapter.textToSpeech;
      if (!fn) {
        throw notImplemented(handle.vendorId, "Text-to-speech", handle.modelId);
      }
      return fn(
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
      );
    });
  }

  function transcribe(opts: TranscribeOptions): Promise<CanonicalTranscriptionResult> {
    return invokeAdapter("transcribe", opts, (adapter, handle, ctx) => {
      const fn = adapter.transcribe;
      if (!fn) {
        throw notImplemented(handle.vendorId, "Transcription", handle.modelId);
      }
      return fn(
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
      );
    });
  }

  function generateVideo(opts: GenerateVideoOptions): Promise<CanonicalVideoResult> {
    return invokeAdapter("video", opts, (adapter, handle, ctx) => {
      const fn = adapter.generateVideo;
      if (!fn) {
        throw notImplemented(handle.vendorId, "Video generation", handle.modelId);
      }
      return fn(
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
      );
    });
  }

  function getVideoJob(opts: VideoJobCallOptions): Promise<CanonicalVideoJob> {
    return invokeAdapter("video_job", opts, (adapter, handle, ctx) => {
      const fn = adapter.getVideoJob;
      if (!fn) {
        throw notImplemented(handle.vendorId, "Video job status", handle.modelId);
      }
      return fn({ videoId: opts.videoId }, ctx);
    });
  }

  function downloadVideo(opts: DownloadVideoOptions): Promise<CanonicalVideoContentResult> {
    if (!opts.videoId && !opts.fileId) {
      throw new LLMError({
        code: "INVALID_REQUEST",
        message: "downloadVideo requires videoId (OpenAI) or fileId (MiniMax)",
        retryable: false,
      });
    }
    return invokeAdapter("video_download", opts, (adapter, handle, ctx) => {
      const fn = adapter.downloadVideo;
      if (!fn) {
        throw notImplemented(handle.vendorId, "Video download", handle.modelId);
      }
      return fn({ videoId: opts.videoId, fileId: opts.fileId }, ctx);
    });
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
