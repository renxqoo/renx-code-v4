/**
 * Functional (module-level) API — import and call directly, no client required.
 *
 * ```ts
 * import { generateText, openai } from "@renx/provider";
 * const r = await generateText({ model: openai("gpt-4o-mini"), prompt: "Hi" });
 * ```
 *
 * Behind the scenes a lazily-initialised default client is used.
 * For advanced scenarios (multi-tenant, custom hooks, …) use `createLLMClient` / `createDefaultLLMClient`.
 */

import { createDefaultLLMClient, type CreateDefaultLLMClientOptions } from "./default-client";
import type { LLMClient, StreamTextResult } from "./client";
import type {
  GenerateImageOptions,
  GenerateTextOptions,
  GenerateVideoOptions,
  StreamTextOptions,
  TextToSpeechOptions,
  TranscribeOptions,
  VideoJobCallOptions,
  DownloadVideoOptions,
} from "./client";
import type {
  CanonicalImageResult,
  CanonicalSpeechResult,
  CanonicalTextResult,
  CanonicalTranscriptionResult,
  CanonicalVideoContentResult,
  CanonicalVideoJob,
  CanonicalVideoResult,
} from "./types";

// ── Lazy singleton ──────────────────────────────────────────────────────────

let _client: LLMClient | null = null;
let _clientOptions: CreateDefaultLLMClientOptions | undefined;

/**
 * Return (or lazily create) the shared default client.
 *
 * @param options — forwarded to `createDefaultLLMClient` on first call.
 *                  Subsequent calls with different options are a no-op
 *                  (the first configuration wins). Call `resetDefaultClient()`
 *                  to force re-creation.
 */
export function getDefaultClient(options?: CreateDefaultLLMClientOptions): LLMClient {
  if (!_client) {
    _clientOptions = options;
    _client = createDefaultLLMClient(options ?? {});
  }
  return _client;
}

/** Discard the cached default client so the next call creates a fresh one. */
export function resetDefaultClient(): void {
  _client = null;
  _clientOptions = undefined;
}

// ── Functional wrappers ─────────────────────────────────────────────────────

export async function generateText(
  options: GenerateTextOptions,
  clientOptions?: CreateDefaultLLMClientOptions,
): Promise<CanonicalTextResult> {
  return getDefaultClient(clientOptions).generateText(options);
}

export async function streamText(
  options: StreamTextOptions,
  clientOptions?: CreateDefaultLLMClientOptions,
): Promise<StreamTextResult> {
  return getDefaultClient(clientOptions).streamText(options);
}

export async function generateImage(
  options: GenerateImageOptions,
  clientOptions?: CreateDefaultLLMClientOptions,
): Promise<CanonicalImageResult> {
  return getDefaultClient(clientOptions).generateImage(options);
}

export async function textToSpeech(
  options: TextToSpeechOptions,
  clientOptions?: CreateDefaultLLMClientOptions,
): Promise<CanonicalSpeechResult> {
  return getDefaultClient(clientOptions).textToSpeech(options);
}

export async function transcribe(
  options: TranscribeOptions,
  clientOptions?: CreateDefaultLLMClientOptions,
): Promise<CanonicalTranscriptionResult> {
  return getDefaultClient(clientOptions).transcribe(options);
}

export async function generateVideo(
  options: GenerateVideoOptions,
  clientOptions?: CreateDefaultLLMClientOptions,
): Promise<CanonicalVideoResult> {
  return getDefaultClient(clientOptions).generateVideo(options);
}

export async function getVideoJob(
  options: VideoJobCallOptions,
  clientOptions?: CreateDefaultLLMClientOptions,
): Promise<CanonicalVideoJob> {
  return getDefaultClient(clientOptions).getVideoJob(options);
}

export async function downloadVideo(
  options: DownloadVideoOptions,
  clientOptions?: CreateDefaultLLMClientOptions,
): Promise<CanonicalVideoContentResult> {
  return getDefaultClient(clientOptions).downloadVideo(options);
}
