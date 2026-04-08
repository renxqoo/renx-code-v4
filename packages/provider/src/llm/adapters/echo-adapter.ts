import { LLMError } from "../errors";
import type { LLMAdapter, AdapterInvokeContext } from "../adapter";
import { flattenMessagePartsForEcho } from "../message-parts";
import type {
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
} from "../types";

const VENDOR = "echo";

function flatten(req: CanonicalRequest): string {
  return req.messages.map((m) => flattenMessagePartsForEcho(m.content)).join("\n");
}

export function createEchoAdapter(): LLMAdapter {
  return {
    vendorId: VENDOR,
    async generateText(
      request: CanonicalRequest,
      _ctx: AdapterInvokeContext,
    ): Promise<CanonicalTextResult> {
      const text = flatten(request);
      return {
        text: `echo:${text}`,
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    async streamText(
      request: CanonicalRequest,
      _ctx: AdapterInvokeContext,
    ): Promise<AsyncIterable<CanonicalStreamChunk>> {
      const text = `echo:${flatten(request)}`;
      async function* gen(): AsyncGenerator<CanonicalStreamChunk> {
        yield { type: "text-delta", textDelta: text };
        yield {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      }
      return gen();
    },
    getCapabilities(_modelId: string) {
      return {
        streaming: true,
        supportsTopP: true,
        supportsStopSequences: true,
        notes: "Test-only adapter; no network.",
      };
    },
    async generateImage(
      request: CanonicalImageRequest,
      _ctx: AdapterInvokeContext,
    ): Promise<CanonicalImageResult> {
      return {
        images: [
          {
            url: `echo://image?model=${encodeURIComponent(request.modelId)}&q=${encodeURIComponent(request.prompt.slice(0, 80))}`,
          },
        ],
      };
    },
    async textToSpeech(
      request: CanonicalSpeechRequest,
      _ctx: AdapterInvokeContext,
    ): Promise<CanonicalSpeechResult> {
      const enc = new TextEncoder();
      return {
        audio: enc.encode(`echo-tts:${request.text.slice(0, 200)}`),
        contentType: "text/plain; charset=utf-8",
      };
    },
    async transcribe(
      request: CanonicalTranscriptionRequest,
      _ctx: AdapterInvokeContext,
    ): Promise<CanonicalTranscriptionResult> {
      const text = new TextDecoder().decode(request.audio.slice(0, 4096));
      return {
        text: `transcribed:${text || "(binary)"}`,
        language: request.language ?? "en",
        durationSeconds: 0,
      };
    },
    async generateVideo(
      request: CanonicalVideoRequest,
      _ctx: AdapterInvokeContext,
    ): Promise<CanonicalVideoResult> {
      return {
        videoId: `echo_vid_${request.prompt.length}_${request.modelId}`,
        status: "queued",
      };
    },
    async getVideoJob(
      query: CanonicalVideoJobQuery,
      _ctx: AdapterInvokeContext,
    ): Promise<CanonicalVideoJob> {
      return {
        videoId: query.videoId,
        status: "completed",
        progress: 100,
        fileId: `echo_file_${query.videoId}`,
      };
    },
    async downloadVideo(
      query: CanonicalVideoDownloadQuery,
      _ctx: AdapterInvokeContext,
    ): Promise<CanonicalVideoContentResult> {
      const enc = new TextEncoder();
      const key = query.videoId ?? query.fileId ?? "";
      return {
        data: enc.encode(`echo-video:${key}`),
        contentType: "text/plain; charset=utf-8",
      };
    },
    mapError(error: unknown, ctx: { modelId?: string }): LLMError {
      if (LLMError.isInstance(error)) return error;
      return new LLMError({
        code: "UNKNOWN",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
        vendor: VENDOR,
        modelId: ctx.modelId,
        cause: error,
      });
    },
  };
}
