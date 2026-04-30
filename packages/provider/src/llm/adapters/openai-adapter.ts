import { LLMError } from "../errors";
import type { LLMAdapter, AdapterInvokeContext } from "../adapter";
import { bearerAuthHeaders, withAdapterFetch } from "../adapter-request";
import { mapHttpError } from "./openai-http-errors";
import { readSseEvents } from "../internal/sse";
import { createOpenAIMultimodalMethods, OPENAI_MULTIMODAL_PATHS } from "./openai-multimodal";
import { openAIContentForMessage } from "../message-parts";
import { assertNoReservedProviderOptions } from "../internal/provider-options";
import { num } from "../internal/util";
import type {
  AdapterEndpoints,
  CanonicalEmbeddingRequest,
  CanonicalEmbeddingResult,
  CanonicalFinishReason,
  CanonicalRequest,
  CanonicalStreamChunk,
  CanonicalTextResult,
  CanonicalToolCall,
  CanonicalUsage,
  ToolCallDeltaChunk,
} from "../types";

const VENDOR = "openai";
export const DEFAULT_BASE = "https://api.openai.com";

export const OPENAI_DEFAULT_PATHS: AdapterEndpoints = {
  chatCompletions: "v1/chat/completions",
  embeddings: "v1/embeddings",
  imageGenerations: "v1/images/generations",
  audioSpeech: "v1/audio/speech",
  audioTranscriptions: "v1/audio/transcriptions",
  videos: "v1/videos",
};

function resolvePaths(ctx: AdapterInvokeContext): AdapterEndpoints {
  if (!ctx.paths) return OPENAI_DEFAULT_PATHS;
  return { ...OPENAI_DEFAULT_PATHS, ...OPENAI_MULTIMODAL_PATHS, ...ctx.paths };
}

function mapOpenAIFinishReason(r: string): CanonicalFinishReason {
  switch (r) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    case "tool_calls":
      return "tool_calls";
    default:
      return "other";
  }
}

function mapOpenAIUsage(u: Record<string, unknown> | undefined): CanonicalUsage | undefined {
  if (!u) return undefined;
  return {
    inputTokens: num(u.prompt_tokens),
    outputTokens: num(u.completion_tokens),
    totalTokens: num(u.total_tokens),
  };
}

function mapOpenAIToolCalls(raw: unknown): CanonicalToolCall[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const calls: CanonicalToolCall[] = [];
  for (const tc of raw as Array<Record<string, unknown>>) {
    const fn = tc.function as Record<string, unknown> | undefined;
    if (typeof tc.id === "string" && fn && typeof fn.name === "string") {
      calls.push({
        id: tc.id,
        name: fn.name,
        arguments: typeof fn.arguments === "string" ? fn.arguments : "",
      });
    }
  }
  return calls.length > 0 ? calls : undefined;
}

function buildBody(req: CanonicalRequest, stream: boolean): Record<string, unknown> {
  const extra = req.providerOptions ?? {};
  assertNoReservedProviderOptions(VENDOR, req.modelId, extra, [
    "apiKey",
    "model",
    "messages",
    "stream",
    "stream_options",
    "temperature",
    "max_tokens",
    "top_p",
    "stop",
    "tools",
    "tool_choice",
  ]);
  const body: Record<string, unknown> = {
    model: req.modelId,
    messages: req.messages.map((m) => {
      // Assistant messages with tool_call parts → role + tool_calls field
      if (m.role === "assistant") {
        const toolCalls = m.content.filter((p) => p.type === "tool_call");
        const textParts = m.content.filter((p) => p.type === "text");
        if (toolCalls.length > 0) {
          return {
            role: m.role,
            content:
              textParts.length > 0
                ? textParts.map((p) => (p as { type: "text"; text: string }).text).join("")
                : null,
            tool_calls: toolCalls.map((tc) => {
              const t = tc as { type: "tool_call"; id: string; name: string; arguments: string };
              return {
                id: t.id,
                type: "function",
                function: { name: t.name, arguments: t.arguments },
              };
            }),
          };
        }
      }
      // Tool result messages → role + tool_call_id + content as string
      if (m.role === "tool") {
        const result = m.content.find((p) => p.type === "tool_result");
        if (result) {
          const r = result as { type: "tool_result"; toolCallId: string; content: string };
          return {
            role: m.role,
            tool_call_id: r.toolCallId,
            content: r.content,
          };
        }
      }
      return {
        role: m.role,
        content: openAIContentForMessage(m.content),
      };
    }),
    stream,
    ...extra,
  };
  const p = req.params;
  if (p.temperature !== undefined) body.temperature = p.temperature;
  if (p.maxOutputTokens !== undefined) body.max_tokens = p.maxOutputTokens;
  if (p.topP !== undefined) body.top_p = p.topP;
  if (p.stopSequences !== undefined) body.stop = p.stopSequences;
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  if (req.toolChoice !== undefined) body.tool_choice = req.toolChoice;
  // Request usage in streaming responses (OpenAI requires this flag)
  if (stream) body.stream_options = { include_usage: true };
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
    const reasoning = delta?.reasoning_content;
    if (typeof reasoning === "string" && reasoning.length > 0) {
      yield { type: "reasoning-delta", reasoningDelta: reasoning };
    }
    const toolCalls = delta?.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls as Array<Record<string, unknown>>) {
        const fn = tc.function as Record<string, unknown> | undefined;
        const chunk: ToolCallDeltaChunk = {
          type: "tool-call-delta",
          index: typeof tc.index === "number" ? tc.index : 0,
        };
        if (typeof tc.id === "string") chunk.id = tc.id;
        if (fn && typeof fn.name === "string") chunk.name = fn.name;
        if (fn && typeof fn.arguments === "string" && fn.arguments.length > 0) {
          chunk.argumentsDelta = fn.arguments;
        }
        yield chunk;
      }
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
      const p = resolvePaths(ctx);
      const path = p.chatCompletions ?? OPENAI_DEFAULT_PATHS.chatCompletions!;
      const base = ctx.baseUrl ?? DEFAULT_BASE;
      const patchedCtx: AdapterInvokeContext = { ...ctx, baseUrl: base };

      return withAdapterFetch(
        patchedCtx,
        path,
        {
          authHeaders: bearerAuthHeaders(ctx.apiKey),
          json: buildBody(request, false),
          modelId: request.modelId,
        },
        async (res) => {
          if (!res.ok) {
            throw await mapHttpError(res, request.modelId, VENDOR);
          }
          const json = (await res.json()) as Record<string, unknown>;
          const choice = (json.choices as Array<Record<string, unknown>>)?.[0];
          const message = choice?.message as Record<string, unknown> | undefined;
          const text = String(message?.content ?? "");
          const finishReason = mapOpenAIFinishReason(String(choice?.finish_reason ?? "stop"));
          return {
            text,
            finishReason,
            toolCalls: mapOpenAIToolCalls(message?.tool_calls),
            usage: mapOpenAIUsage(json.usage as Record<string, unknown> | undefined),
            raw: json,
          };
        },
      );
    },
    async streamText(
      request: CanonicalRequest,
      ctx: AdapterInvokeContext,
    ): Promise<AsyncIterable<CanonicalStreamChunk>> {
      const p = resolvePaths(ctx);
      const path = p.chatCompletions ?? OPENAI_DEFAULT_PATHS.chatCompletions!;
      const base = ctx.baseUrl ?? DEFAULT_BASE;
      const patchedCtx: AdapterInvokeContext = { ...ctx, baseUrl: base };

      const res = await withAdapterFetch(
        patchedCtx,
        path,
        {
          authHeaders: bearerAuthHeaders(ctx.apiKey),
          json: buildBody(request, true),
          modelId: request.modelId,
        },
        async (r) => r,
      );

      if (!res.ok) {
        throw await mapHttpError(res, request.modelId, VENDOR);
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
    generateEmbedding: async (
      request: CanonicalEmbeddingRequest,
      ctx: AdapterInvokeContext,
    ): Promise<CanonicalEmbeddingResult> => {
      const p = resolvePaths(ctx);
      const path = p.embeddings ?? OPENAI_DEFAULT_PATHS.embeddings!;
      const base = ctx.baseUrl ?? DEFAULT_BASE;
      const patchedCtx: AdapterInvokeContext = { ...ctx, baseUrl: base };

      return withAdapterFetch(
        patchedCtx,
        path,
        {
          authHeaders: bearerAuthHeaders(ctx.apiKey),
          json: {
            model: request.modelId,
            input: request.input,
            ...(request.providerOptions ?? {}),
          },
          modelId: request.modelId,
        },
        async (res) => {
          if (!res.ok) throw await mapHttpError(res, request.modelId, VENDOR);
          const json = (await res.json()) as Record<string, unknown>;
          const data = json.data as Array<Record<string, unknown>> | undefined;
          const embeddings = (data ?? []).map(
            (item) => (item as { embedding: number[] }).embedding,
          );
          return {
            embeddings,
            modelId: request.modelId,
            usage: mapOpenAIUsage(json.usage as Record<string, unknown> | undefined),
            raw: json,
          };
        },
      );
    },
    ...createOpenAIMultimodalMethods(DEFAULT_BASE),
  };
}
