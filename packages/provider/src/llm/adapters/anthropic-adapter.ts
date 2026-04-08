import { LLMError } from "../errors";
import type { LLMAdapter, AdapterInvokeContext } from "../adapter";
import { withAdapterFetch } from "../adapter-request";
import { mapHttpError } from "./openai-http-errors";
import { anthropicContentBlocks, flattenTextParts, hasNonTextPart } from "../message-parts";
import { assertNoReservedProviderOptions } from "../internal/provider-options";
import { readSseEvents } from "../internal/sse";
import { num } from "../internal/util";
import type {
  AdapterEndpoints,
  CanonicalFinishReason,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalStreamChunk,
  CanonicalTextResult,
  CanonicalUsage,
  TextPart,
} from "../types";

const VENDOR = "anthropic";
export const DEFAULT_BASE = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

export const ANTHROPIC_DEFAULT_PATHS: AdapterEndpoints = {
  messages: "v1/messages",
};

function resolvePath(ctx: AdapterInvokeContext): string {
  return ctx.paths?.messages ?? ANTHROPIC_DEFAULT_PATHS.messages!;
}

function messageContentForAnthropic(m: CanonicalMessage, modelId: string): unknown[] {
  if (m.role === "assistant" && hasNonTextPart(m.content)) {
    throw new LLMError({
      code: "INVALID_REQUEST",
      message: "Anthropic adapter: assistant messages cannot contain image parts",
      retryable: false,
      vendor: VENDOR,
      modelId,
    });
  }
  return anthropicContentBlocks(m.content);
}

function splitAnthropicMessages(request: CanonicalRequest): {
  system?: string;
  messages: { role: "user" | "assistant"; content: unknown[] }[];
} {
  const systemParts: string[] = [];
  const messages: {
    role: "user" | "assistant";
    content: unknown[];
  }[] = [];
  for (const m of request.messages) {
    if (m.role === "system") {
      if (hasNonTextPart(m.content)) {
        throw new LLMError({
          code: "INVALID_REQUEST",
          message: "Anthropic adapter: system messages cannot contain image parts",
          retryable: false,
          vendor: VENDOR,
          modelId: request.modelId,
        });
      }
      systemParts.push(flattenTextParts(m.content.filter((p): p is TextPart => p.type === "text")));
    } else if (m.role === "user" || m.role === "assistant") {
      messages.push({
        role: m.role,
        content: messageContentForAnthropic(m, request.modelId),
      });
    } else {
      // tool role — not supported by Anthropic adapter yet
      throw new LLMError({
        code: "NOT_IMPLEMENTED",
        message: `Anthropic adapter does not support role="${m.role}" messages (tool calling not yet implemented)`,
        retryable: false,
        vendor: VENDOR,
        modelId: request.modelId,
      });
    }
  }
  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages,
  };
}

function mapAnthropicStopReason(r: string): CanonicalFinishReason {
  switch (r) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "refusal":
    case "content_filter":
      return "content_filter";
    default:
      return "other";
  }
}

function buildBody(request: CanonicalRequest, stream: boolean): Record<string, unknown> {
  const extra = request.providerOptions ?? {};
  assertNoReservedProviderOptions(VENDOR, request.modelId, extra, [
    "apiKey",
    "model",
    "max_tokens",
    "messages",
    "stream",
    "system",
    "temperature",
    "top_p",
    "stop_sequences",
  ]);
  const { system, messages } = splitAnthropicMessages(request);
  if (messages.length === 0) {
    throw new LLMError({
      code: "INVALID_REQUEST",
      message: "Anthropic requires at least one user or assistant message after system extraction",
      retryable: false,
      vendor: VENDOR,
      modelId: request.modelId,
    });
  }
  const maxTokens = request.params.maxOutputTokens ?? 8192;
  const body: Record<string, unknown> = {
    model: request.modelId,
    max_tokens: maxTokens,
    messages,
    stream,
    ...extra,
  };
  if (system !== undefined) body.system = system;
  const p = request.params;
  if (p.temperature !== undefined) body.temperature = p.temperature;
  if (p.topP !== undefined) body.top_p = p.topP;
  if (p.stopSequences !== undefined) body.stop_sequences = p.stopSequences;
  return body;
}

async function* anthropicStreamChunks(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<CanonicalStreamChunk> {
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let stopReason: CanonicalFinishReason | undefined;

  for await (const ev of readSseEvents(body)) {
    if (!ev.data) continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = String(j.type ?? "");

    if (type === "message_start") {
      const message = j.message as Record<string, unknown> | undefined;
      const usage = message?.usage as Record<string, unknown> | undefined;
      inputTokens = num(usage?.input_tokens) ?? inputTokens;
    }

    if (type === "content_block_delta") {
      const delta = j.delta as Record<string, unknown> | undefined;
      if (delta?.type === "text_delta") {
        const text = String(delta.text ?? "");
        if (text.length > 0) yield { type: "text-delta", textDelta: text };
      }
    }

    if (type === "message_delta") {
      const d = j.delta as Record<string, unknown> | undefined;
      if (d?.stop_reason != null && String(d.stop_reason).length > 0) {
        stopReason = mapAnthropicStopReason(String(d.stop_reason));
      }
      const u = j.usage as Record<string, unknown> | undefined;
      if (u) {
        outputTokens = num(u.output_tokens) ?? outputTokens;
      }
    }
  }

  const usage: CanonicalUsage | undefined =
    inputTokens !== undefined || outputTokens !== undefined
      ? {
          inputTokens,
          outputTokens,
          totalTokens:
            inputTokens !== undefined && outputTokens !== undefined
              ? inputTokens + outputTokens
              : undefined,
        }
      : undefined;

  yield {
    type: "finish",
    finishReason: stopReason ?? "stop",
    usage,
  };
}

export function createAnthropicAdapter(): LLMAdapter {
  return {
    vendorId: VENDOR,
    async generateText(
      request: CanonicalRequest,
      ctx: AdapterInvokeContext,
    ): Promise<CanonicalTextResult> {
      const path = resolvePath(ctx);
      const base = ctx.baseUrl ?? DEFAULT_BASE;
      const patchedCtx: AdapterInvokeContext = { ...ctx, baseUrl: base };

      return withAdapterFetch(
        patchedCtx,
        path,
        {
          json: buildBody(request, false),
          modelId: request.modelId,
          headers: {
            "x-api-key": ctx.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
        },
        async (res) => {
          if (!res.ok) {
            throw await mapHttpError(res, request.modelId, VENDOR);
          }
          const json = (await res.json()) as Record<string, unknown>;
          const content = json.content as Array<Record<string, unknown>> | undefined;
          const textBlock = content?.find((c) => c.type === "text") as
            | { text?: string }
            | undefined;
          const text = String(textBlock?.text ?? "");
          const stopReason = mapAnthropicStopReason(String(json.stop_reason ?? "end_turn"));
          const u = json.usage as Record<string, unknown> | undefined;
          const usage: CanonicalUsage | undefined = u
            ? {
                inputTokens: num(u.input_tokens),
                outputTokens: num(u.output_tokens),
              }
            : undefined;
          return { text, finishReason: stopReason, usage, raw: json };
        },
      );
    },
    async streamText(
      request: CanonicalRequest,
      ctx: AdapterInvokeContext,
    ): Promise<AsyncIterable<CanonicalStreamChunk>> {
      const path = resolvePath(ctx);
      const base = ctx.baseUrl ?? DEFAULT_BASE;
      const patchedCtx: AdapterInvokeContext = { ...ctx, baseUrl: base };

      const res = await withAdapterFetch(
        patchedCtx,
        path,
        {
          json: buildBody(request, true),
          modelId: request.modelId,
          headers: {
            "x-api-key": ctx.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
        },
        async (r) => r,
      );

      if (!res.ok) {
        throw await mapHttpError(res, request.modelId, VENDOR);
      }
      return anthropicStreamChunks(res.body);
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
  };
}
