import { LLMError, RetryableError } from "../errors";
import type { LLMAdapter, AdapterInvokeContext } from "../adapter";
import { isFetchAbortError, withOptionalTimeout } from "../abort";
import { mapOpenAIHttpError } from "../openai-http-errors";
import { readSseEvents } from "../sse";
import { createOpenAIMultimodalMethods } from "../openai-multimodal";
import { openAIContentForMessage } from "../message-parts";
import type {
  CanonicalFinishReason,
  CanonicalRequest,
  CanonicalStreamChunk,
  CanonicalTextResult,
  CanonicalUsage,
} from "../types";

const VENDOR = "openai";
const DEFAULT_BASE = "https://api.openai.com/v1";

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function mapOpenAIFinishReason(r: string): CanonicalFinishReason {
  switch (r) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    default:
      return "other";
  }
}

function mapOpenAIUsage(
  u: Record<string, unknown> | undefined,
): CanonicalUsage | undefined {
  if (!u) return undefined;
  return {
    inputTokens: num(u.prompt_tokens),
    outputTokens: num(u.completion_tokens),
    totalTokens: num(u.total_tokens),
  };
}

function buildBody(req: CanonicalRequest, stream: boolean): Record<string, unknown> {
  const extra = (req.providerOptions?.openai ?? {}) as Record<string, unknown>;
  const body: Record<string, unknown> = {
    model: req.modelId,
    messages: req.messages.map((m) => ({
      role: m.role,
      content: openAIContentForMessage(m.content),
    })),
    stream,
    ...extra,
  };
  const p = req.params;
  if (p.temperature !== undefined) body.temperature = p.temperature;
  if (p.maxOutputTokens !== undefined) body.max_tokens = p.maxOutputTokens;
  if (p.topP !== undefined) body.top_p = p.topP;
  if (p.stopSequences !== undefined) body.stop = p.stopSequences;
  return body;
}

async function* openAIStreamChunks(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<CanonicalStreamChunk> {
  let lastUsage: CanonicalUsage | undefined;
  let lastFinish: CanonicalFinishReason | undefined;
  for await (const ev of readSseEvents(body)) {
    if (ev.data === "[DONE]") break;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const choices = j.choices as Array<Record<string, unknown>> | undefined;
    const choice0 = choices?.[0];
    const delta = choice0?.delta as Record<string, unknown> | undefined;
    const content = delta?.content;
    if (typeof content === "string" && content.length > 0) {
      yield { type: "text-delta", textDelta: content };
    }
    const fr = choice0?.finish_reason;
    if (fr != null && String(fr).length > 0) {
      lastFinish = mapOpenAIFinishReason(String(fr));
    }
    const u = j.usage as Record<string, unknown> | undefined;
    if (u) lastUsage = mapOpenAIUsage(u);
  }
  yield {
    type: "finish",
    finishReason: lastFinish ?? "stop",
    usage: lastUsage,
  };
}

export function createOpenAIAdapter(): LLMAdapter {
  return {
    vendorId: VENDOR,
    async generateText(
      request: CanonicalRequest,
      ctx: AdapterInvokeContext,
    ): Promise<CanonicalTextResult> {
      const base = ctx.baseUrl ?? DEFAULT_BASE;
      const url = `${base.replace(/\/$/, "")}/chat/completions`;
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
          body: JSON.stringify(buildBody(request, false)),
          signal,
        });
        if (!res.ok) {
          throw await mapOpenAIHttpError(res, request.modelId);
        }
        const json = (await res.json()) as Record<string, unknown>;
        const choice = (json.choices as Array<Record<string, unknown>>)?.[0];
        const message = choice?.message as Record<string, unknown> | undefined;
        const text = String(message?.content ?? "");
        const finishReason = mapOpenAIFinishReason(
          String(choice?.finish_reason ?? "stop"),
        );
        return {
          text,
          finishReason,
          usage: mapOpenAIUsage(json.usage as Record<string, unknown> | undefined),
          raw: json,
        };
      } catch (e) {
        if (LLMError.isInstance(e)) throw e;
        if (isFetchAbortError(e)) {
          throw new LLMError({
            code: "ABORTED",
            message: "Request aborted",
            retryable: false,
            vendor: VENDOR,
            modelId: request.modelId,
            cause: e,
          });
        }
        if (e instanceof TypeError) {
          throw new RetryableError({
            code: "NETWORK",
            message: e.message,
            vendor: VENDOR,
            modelId: request.modelId,
            cause: e,
          });
        }
        throw new LLMError({
          code: "UNKNOWN",
          message: e instanceof Error ? e.message : String(e),
          retryable: false,
          vendor: VENDOR,
          modelId: request.modelId,
          cause: e,
        });
      } finally {
        dispose();
      }
    },
    async streamText(
      request: CanonicalRequest,
      ctx: AdapterInvokeContext,
    ): Promise<AsyncIterable<CanonicalStreamChunk>> {
      const base = ctx.baseUrl ?? DEFAULT_BASE;
      const url = `${base.replace(/\/$/, "")}/chat/completions`;
      const { signal, dispose } = withOptionalTimeout(
        ctx.abortSignal,
        ctx.timeoutMs,
      );
      let res: Response;
      try {
        res = await ctx.fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ctx.apiKey}`,
          },
          body: JSON.stringify(buildBody(request, true)),
          signal,
        });
      } catch (e) {
        dispose();
        if (LLMError.isInstance(e)) throw e;
        if (isFetchAbortError(e)) {
          throw new LLMError({
            code: "ABORTED",
            message: "Request aborted",
            retryable: false,
            vendor: VENDOR,
            modelId: request.modelId,
            cause: e,
          });
        }
        if (e instanceof TypeError) {
          throw new RetryableError({
            code: "NETWORK",
            message: e.message,
            vendor: VENDOR,
            modelId: request.modelId,
            cause: e,
          });
        }
        throw new LLMError({
          code: "UNKNOWN",
          message: e instanceof Error ? e.message : String(e),
          retryable: false,
          vendor: VENDOR,
          modelId: request.modelId,
          cause: e,
        });
      }
      dispose();
      if (!res.ok) {
        throw await mapOpenAIHttpError(res, request.modelId);
      }
      return openAIStreamChunks(res.body);
    },
    getCapabilities(_modelId: string) {
      return {
        streaming: true,
        supportsTopP: true,
        supportsStopSequences: true,
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
    ...createOpenAIMultimodalMethods(),
  };
}
