/**
 * Functional (module-level) API — import and call directly, no client required.
 *
 * ```ts
 * import { generateText, openai } from "@renx/provider";
 * const r = await generateText({ model: openai("gpt-4o-mini"), prompt: "Hi" });
 * ```
 *
 * - 无第二参数时：使用进程内**懒加载单例** `createDefaultLLMClient({})`（读环境变量密钥等）。
 * - 有第二参数时：每次调用 **`createDefaultLLMClient(clientOptions)` 新实例**，不污染单例。
 *
 * 需要长期持有同一 Client（如 Agent、多租户）请用 `createDefaultLLMClient` / `createLLMClient`。
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

// ── Lazy singleton（仅当未传第二参数时使用）────────────────────────────────────

let _singleton: LLMClient | null = null;

function getSingleton(): LLMClient {
  if (!_singleton) {
    _singleton = createDefaultLLMClient({});
  }
  return _singleton;
}

function resolveClient(clientOptions?: CreateDefaultLLMClientOptions): LLMClient {
  if (clientOptions !== undefined) {
    return createDefaultLLMClient(clientOptions);
  }
  return getSingleton();
}

// ── Functional wrappers ─────────────────────────────────────────────────────

export async function generateText(
  options: GenerateTextOptions,
  clientOptions?: CreateDefaultLLMClientOptions,
): Promise<CanonicalTextResult> {
  return resolveClient(clientOptions).generateText(options);
}

export async function streamText(
  options: StreamTextOptions,
  clientOptions?: CreateDefaultLLMClientOptions,
): Promise<StreamTextResult> {
  return resolveClient(clientOptions).streamText(options);
}

export async function generateImage(
  options: GenerateImageOptions,
  clientOptions?: CreateDefaultLLMClientOptions,
): Promise<CanonicalImageResult> {
  return resolveClient(clientOptions).generateImage(options);
}

export async function textToSpeech(
  options: TextToSpeechOptions,
  clientOptions?: CreateDefaultLLMClientOptions,
): Promise<CanonicalSpeechResult> {
  return resolveClient(clientOptions).textToSpeech(options);
}

export async function transcribe(
  options: TranscribeOptions,
  clientOptions?: CreateDefaultLLMClientOptions,
): Promise<CanonicalTranscriptionResult> {
  return resolveClient(clientOptions).transcribe(options);
}

export async function generateVideo(
  options: GenerateVideoOptions,
  clientOptions?: CreateDefaultLLMClientOptions,
): Promise<CanonicalVideoResult> {
  return resolveClient(clientOptions).generateVideo(options);
}

export async function getVideoJob(
  options: VideoJobCallOptions,
  clientOptions?: CreateDefaultLLMClientOptions,
): Promise<CanonicalVideoJob> {
  return resolveClient(clientOptions).getVideoJob(options);
}

export async function downloadVideo(
  options: DownloadVideoOptions,
  clientOptions?: CreateDefaultLLMClientOptions,
): Promise<CanonicalVideoContentResult> {
  return resolveClient(clientOptions).downloadVideo(options);
}
