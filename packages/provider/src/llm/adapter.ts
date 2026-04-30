import type { LLMError } from "./errors";
import type {
  AdapterCapabilities,
  CanonicalEmbeddingRequest,
  CanonicalEmbeddingResult,
  CanonicalImageRequest,
  CanonicalImageResult,
  CanonicalRequest,
  CanonicalSpeechRequest,
  CanonicalSpeechResult,
  CanonicalStreamChunk,
  CanonicalTextResult,
  CanonicalTranscriptionRequest,
  CanonicalTranscriptionResult,
  CanonicalVideoContentResult,
  CanonicalVideoDownloadQuery,
  CanonicalVideoJob,
  CanonicalVideoJobQuery,
  CanonicalVideoRequest,
  CanonicalVideoResult,
} from "./types";

export type AdapterInvokeContext = {
  fetch: typeof fetch;
  apiKey: string;
  baseUrl?: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  vendorId: string;
  strictParams?: boolean;
  onWarning?: (message: string) => void;
  /** Per-vendor endpoint path overrides (merged with adapter defaults). */
  paths?: Record<string, string>;
};

export interface LLMAdapter {
  readonly vendorId: string;
  generateText(request: CanonicalRequest, ctx: AdapterInvokeContext): Promise<CanonicalTextResult>;
  streamText(
    request: CanonicalRequest,
    ctx: AdapterInvokeContext,
  ): Promise<AsyncIterable<CanonicalStreamChunk>>;
  getCapabilities(modelId: string): AdapterCapabilities;
  mapError(error: unknown, ctx: { modelId?: string }): LLMError;

  /** Image generation (e.g. OpenAI Images API). */
  generateImage?(
    request: CanonicalImageRequest,
    ctx: AdapterInvokeContext,
  ): Promise<CanonicalImageResult>;

  /** Text-to-speech. */
  textToSpeech?(
    request: CanonicalSpeechRequest,
    ctx: AdapterInvokeContext,
  ): Promise<CanonicalSpeechResult>;

  /** Speech-to-text. */
  transcribe?(
    request: CanonicalTranscriptionRequest,
    ctx: AdapterInvokeContext,
  ): Promise<CanonicalTranscriptionResult>;

  /** Start async video generation job. */
  generateVideo?(
    request: CanonicalVideoRequest,
    ctx: AdapterInvokeContext,
  ): Promise<CanonicalVideoResult>;

  /** Poll video job status. */
  getVideoJob?(
    query: CanonicalVideoJobQuery,
    ctx: AdapterInvokeContext,
  ): Promise<CanonicalVideoJob>;

  /** Download completed video bytes (e.g. MP4). */
  downloadVideo?(
    query: CanonicalVideoDownloadQuery,
    ctx: AdapterInvokeContext,
  ): Promise<CanonicalVideoContentResult>;

  /** Generate vector embeddings (e.g. OpenAI text-embedding-3). */
  generateEmbedding?(
    request: CanonicalEmbeddingRequest,
    ctx: AdapterInvokeContext,
  ): Promise<CanonicalEmbeddingResult>;
}
