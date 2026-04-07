import { LLMError, RetryableError } from "../errors";
import type { LLMAdapter, AdapterInvokeContext } from "../adapter";
import { isFetchAbortError, withOptionalTimeout } from "../abort";
import { readJsonOrText } from "../http-util";
import {
  anthropicContentBlocks,
  flattenTextParts,
  hasNonTextPart,
} from "../message-parts";
import { readSseEvents } from "../sse";
import type {
  CanonicalFinishReason,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalStreamChunk,
  CanonicalTextResult,
  CanonicalUsage,
  TextPart,
} from "../types";

const VENDOR = "anthropic";
const DEFAULT_BASE = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function messageContentForAnthropic(
  m: CanonicalMessage,
  modelId: string,
): unknown[] {
  if (m.role === "assistant" && hasNonTextPart(m.content)) {
    throw new LLMError({
      code: "INVALID_REQUEST",
      message:
        "Anthropic adapter: assistant messages cannot contain image parts",
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
          message:
            "Anthropic adapter: system messages cannot contain image parts",
          retryable: false,
          vendor: VENDOR,
          modelId: request.modelId,
        });
      }
      systemParts.push(
        flattenTextParts(
          m.content.filter((p): p is TextPart => p.type === "text"),
        ),
      );
    } else if (m.role === "user" || m.role === "assistant") {
      messages.push({
        role: m.role,
        content: messageContentForAnthropic(m, request.modelId),
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

function buildBody(
  request: CanonicalRequest,
  stream: boolean,
): Record<string, unknown> {
  const extra = (request.providerOptions?.anthropic ?? {}) as Record<
    string,
    unknown
  >;
  const { system, messages } = splitAnthropicMessages(request);
  if (messages.length === 0) {
    throw new LLMError({
      code: "INVALID_REQUEST",
      message:
        "Anthropic requires at least one user or assistant message after system extraction",
      retryable: false,
      vendor: VENDOR,
      modelId: request.modelId,
    });
  }
  const maxTokens = request.params.maxOutputTokens ?? 4096;
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
  if (p.stopSequences !== undefined)
    body.stop_sequences = p.stopSequences;
  return body;
}

async function mapAnthropicHttpError(
  res: Response,
  modelId: string,
): Promise<LLMError> {
  const payload = await readJsonOrText(res);
  const msg =
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof (payload as { error?: { message?: unknown } }).error?.message ===
      "string"
      ? String((payload as { error: { message: string } }).error.message)
      : typeof payload === "string"
        ? payload
        : res.statusText;
  const status = res.status;
  if (status === 401 || status === 403) {
    return new LLMError({
      code: "UNAUTHORIZED",
      message: msg,
      retryable: false,
      vendor: VENDOR,
      modelId,
      httpStatus: status,
    });
  }
  if (status === 429) {
    return new RetryableError({
      code: "RATE_LIMIT",
      message: msg,
      vendor: VENDOR,
      modelId,
      httpStatus: status,
    });
  }
  if (status >= 500) {
    return new RetryableError({
      code: "PROVIDER_ERROR",
      message: msg,
      vendor: VENDOR,
      modelId,
      httpStatus: status,
    });
  }
  if (status === 404) {
    return new LLMError({
      code: "MODEL_NOT_FOUND",
      message: msg,
      retryable: false,
      vendor: VENDOR,
      modelId,
      httpStatus: status,
    });
  }
  return new LLMError({
    code: "INVALID_REQUEST",
    message: msg,
    retryable: false,
    vendor: VENDOR,
    modelId,
    httpStatus: status,
  });
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
      const base = ctx.baseUrl ?? DEFAULT_BASE;
      const url = `${base.replace(/\/$/, "")}/messages`;
      const { signal, dispose } = withOptionalTimeout(
        ctx.abortSignal,
        ctx.timeoutMs,
      );
      try {
        const res = await ctx.fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": ctx.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          body: JSON.stringify(buildBody(request, false)),
          signal,
        });
        if (!res.ok) {
          throw await mapAnthropicHttpError(res, request.modelId);
        }
        const json = (await res.json()) as Record<string, unknown>;
        const content = json.content as Array<Record<string, unknown>> | undefined;
        const textBlock = content?.find((c) => c.type === "text") as
          | { text?: string }
          | undefined;
        const text = String(textBlock?.text ?? "");
        const stopReason = mapAnthropicStopReason(
          String(json.stop_reason ?? "end_turn"),
        );
        const u = json.usage as Record<string, unknown> | undefined;
        const usage: CanonicalUsage | undefined = u
          ? {
              inputTokens: num(u.input_tokens),
              outputTokens: num(u.output_tokens),
            }
          : undefined;
        return { text, finishReason: stopReason, usage, raw: json };
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
      const url = `${base.replace(/\/$/, "")}/messages`;
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
            "x-api-key": ctx.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
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
        throw await mapAnthropicHttpError(res, request.modelId);
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
