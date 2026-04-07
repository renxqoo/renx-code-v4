import { afterEach, describe, expect, it, vi } from "vitest";
import { withOptionalTimeout } from "./abort";
import { createAnthropicAdapter } from "./adapters/anthropic-adapter";
import { createEchoAdapter } from "./adapters/echo-adapter";
import { createOpenAIAdapter } from "./adapters/openai-adapter";
import { buildCanonicalRequest } from "./build-canonical-request";
import { createLLMClient } from "./client";
import {
  createEnvApiKeyResolver,
  createStaticApiKeyResolver,
} from "./credentials";
import {
  LLMError,
  RetryableError,
  isRetryableLlmError,
  type LLMErrorCode,
} from "./errors";
import { readJsonOrText } from "./http-util";
import { modelRef, parseModelRefString } from "./model-ref";
import { toPublicMessage } from "./public-message";
import { createOpenAIAndAnthropicRegistry } from "./presets";
import { LLMRegistry, createRegistry } from "./registry";
import {
  defaultIsRetryable,
  defaultRetryPolicy,
  executeWithRetry,
  mergeRetryPolicy,
} from "./retry";
import { readSseEvents } from "./sse";
import type { LLMAdapter } from "./adapter";
import type { CanonicalRequest, CanonicalStreamChunk } from "./types";

function bytes(s: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(s));
      controller.close();
    },
  });
}

const minimalReq: CanonicalRequest = {
  modelId: "m",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  params: {},
};

const ctx = (fetch: typeof fetch): AdapterInvokeContext => ({
  fetch,
  apiKey: "k",
  vendorId: "openai",
});

describe("withOptionalTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns idle controller when no timeout and no parent", () => {
    const { signal, dispose } = withOptionalTimeout(undefined, undefined);
    expect(signal.aborted).toBe(false);
    dispose();
  });

  it("returns parent when no timeout", () => {
    const ac = new AbortController();
    const { signal, dispose } = withOptionalTimeout(ac.signal, undefined);
    expect(signal).toBe(ac.signal);
    dispose();
  });

  it("aborts on timeout when no parent", async () => {
    vi.useFakeTimers();
    const { signal, dispose } = withOptionalTimeout(undefined, 1000);
    const p = new Promise<unknown>((resolve) => {
      signal.addEventListener("abort", () => resolve(signal.reason), {
        once: true,
      });
    });
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(LLMError.isInstance(signal.reason)).toBe(true);
    dispose();
  });

  it("returns parent immediately when parent already aborted with timeout set", () => {
    const ac = new AbortController();
    ac.abort();
    const { signal, dispose } = withOptionalTimeout(ac.signal, 5000);
    expect(signal).toBe(ac.signal);
    dispose();
  });

  it("merges parent abort before timeout", async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const { signal, dispose } = withOptionalTimeout(ac.signal, 60_000);
    const p = new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(signal.reason), {
        once: true,
      });
    });
    ac.abort("u");
    await expect(p).resolves.toBe("u");
    dispose();
    vi.useRealTimers();
  });
});

describe("readSseEvents", () => {
  it("no-ops on null body", async () => {
    const out: unknown[] = [];
    for await (const e of readSseEvents(null)) out.push(e);
    expect(out).toEqual([]);
  });

  it("parses event and multiline data, skips comments", async () => {
    const raw =
      ": comment\n\n" +
      "event: msg\n" +
      "data: {\"a\":1}\n" +
      "\n" +
      "data: partial\n" +
      "data: line\n" +
      "\n";
    const out: { event?: string; data: string }[] = [];
    for await (const e of readSseEvents(bytes(raw))) out.push(e);
    expect(out).toEqual([
      { event: "msg", data: '{"a":1}' },
      { data: "partial\nline" },
    ]);
  });
});

describe("readJsonOrText", () => {
  it("parses JSON content-type", async () => {
    const res = new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
    await expect(readJsonOrText(res)).resolves.toEqual({ ok: true });
  });

  it("falls back to text when JSON parse fails", async () => {
    const res = {
      headers: { get: (n: string) => (n === "content-type" ? "application/json" : null) },
      json: vi.fn().mockRejectedValue(new SyntaxError("bad json")),
      text: vi.fn().mockResolvedValue("fallback-body"),
    } as unknown as Response;
    await expect(readJsonOrText(res)).resolves.toBe("fallback-body");
  });

  it("reads text for non-JSON content-type", async () => {
    const res = new Response("plain", {
      headers: { "content-type": "text/plain" },
    });
    await expect(readJsonOrText(res)).resolves.toBe("plain");
  });

  it("reads text when content-type header is missing", async () => {
    const res = new Response("body", { headers: new Headers() });
    await expect(readJsonOrText(res)).resolves.toBe("body");
  });
});

describe("credentials", () => {
  it("createStaticApiKeyResolver returns key by vendor", () => {
    const r = createStaticApiKeyResolver({ openai: "sk" });
    expect(r("openai")).toBe("sk");
    expect(r("other")).toBeUndefined();
  });

  it("createEnvApiKeyResolver uses explicit env", () => {
    const r = createEnvApiKeyResolver({
      OPENAI_API_KEY: "a",
      ANTHROPIC_API_KEY: "b",
    });
    expect(r("openai")).toBe("a");
    expect(r("anthropic")).toBe("b");
    expect(r("x")).toBeUndefined();
  });

  it("createEnvApiKeyResolver with no args uses process env lookup", () => {
    const r = createEnvApiKeyResolver();
    expect(typeof r).toBe("function");
    const v = r("openai");
    expect(v === undefined || typeof v === "string").toBe(true);
  });
});

describe("toPublicMessage", () => {
  it("uses default for unknown code", () => {
    expect(toPublicMessage("NOT_LISTED" as LLMErrorCode)).toBe(
      toPublicMessage("UNKNOWN"),
    );
  });

  it("covers all known codes", () => {
    const codes = [
      "UNAUTHORIZED",
      "RATE_LIMIT",
      "QUOTA_EXCEEDED",
      "INVALID_REQUEST",
      "MODEL_NOT_FOUND",
      "MODEL_NOT_AVAILABLE",
      "NOT_IMPLEMENTED",
      "TIMEOUT",
      "NETWORK",
      "PROVIDER_ERROR",
      "INVALID_RESPONSE",
      "CONTENT_FILTER",
      "ABORTED",
      "UNKNOWN",
    ] as const;
    for (const c of codes) {
      expect(toPublicMessage(c).length).toBeGreaterThan(0);
    }
  });
});

describe("errors helpers", () => {
  it("isRetryableLlmError", () => {
    expect(isRetryableLlmError(new RetryableError({ code: "RATE_LIMIT", message: "x" }))).toBe(
      true,
    );
    expect(
      isRetryableLlmError(
        new LLMError({ code: "INVALID_REQUEST", message: "x", retryable: false }),
      ),
    ).toBe(false);
    expect(isRetryableLlmError(new Error("x"))).toBe(false);
  });

  it("LLMError.isInstance", () => {
    expect(LLMError.isInstance(new LLMError({ code: "UNKNOWN", message: "m", retryable: false }))).toBe(
      true,
    );
    expect(LLMError.isInstance(new Error())).toBe(false);
  });
});

describe("mergeRetryPolicy", () => {
  it("merges partial into base", () => {
    const m = mergeRetryPolicy(defaultRetryPolicy, { maxAttempts: 9 });
    expect(m.maxAttempts).toBe(9);
    expect(m.initialDelayMs).toBe(defaultRetryPolicy.initialDelayMs);
  });
});

describe("defaultIsRetryable", () => {
  it("delegates to isRetryableLlmError", () => {
    expect(
      defaultIsRetryable(new RetryableError({ code: "RATE_LIMIT", message: "x" })),
    ).toBe(true);
    expect(
      defaultIsRetryable(
        new LLMError({ code: "INVALID_REQUEST", message: "x", retryable: false }),
      ),
    ).toBe(false);
  });
});

describe("executeWithRetry edge cases", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects when maxAttempts < 1", async () => {
    await expect(
      executeWithRetry(async () => "x", {
        policy: { ...defaultRetryPolicy, maxAttempts: 0 },
        isRetryable: () => true,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("aborts when signal aborted before attempt", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      executeWithRetry(async () => "x", {
        policy: { ...defaultRetryPolicy, maxAttempts: 3, initialDelayMs: 0, jitterRatio: 0 },
        abortSignal: ac.signal,
        isRetryable: () => true,
      }),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("throws when deadline already passed", async () => {
    await expect(
      executeWithRetry(async () => "x", {
        policy: { ...defaultRetryPolicy, maxAttempts: 3, initialDelayMs: 0, jitterRatio: 0 },
        deadlineMs: -1,
        isRetryable: () => true,
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("skips sleep when next delay would exceed deadline", async () => {
    vi.useFakeTimers();
    let n = 0;
    await expect(
      executeWithRetry(
        async () => {
          n++;
          if (n < 2) {
            throw new RetryableError({ code: "RATE_LIMIT", message: "r" });
          }
          return "ok";
        },
        {
          policy: {
            ...defaultRetryPolicy,
            maxAttempts: 5,
            initialDelayMs: 999_999,
            maxDelayMs: 999_999,
            jitterRatio: 0,
          },
          deadlineMs: 100,
          isRetryable: (e) => LLMError.isInstance(e) && e.retryable,
        },
      ),
    ).rejects.toMatchObject({ code: "RATE_LIMIT" });
    vi.useRealTimers();
  });

  it("calls onRetry", async () => {
    const onRetry = vi.fn();
    let n = 0;
    await executeWithRetry(
      async () => {
        n++;
        if (n < 2) throw new RetryableError({ code: "RATE_LIMIT", message: "r" });
        return 1;
      },
      {
        policy: { ...defaultRetryPolicy, maxAttempts: 3, initialDelayMs: 0, jitterRatio: 0 },
        isRetryable: (e) => LLMError.isInstance(e) && e.retryable,
        onRetry,
      },
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("rejects sleep when aborted during backoff", async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const p = executeWithRetry(
      async () => {
        throw new RetryableError({ code: "RATE_LIMIT", message: "r" });
      },
      {
        policy: {
          ...defaultRetryPolicy,
          maxAttempts: 3,
          initialDelayMs: 10_000,
          jitterRatio: 0,
        },
        abortSignal: ac.signal,
        isRetryable: () => true,
      },
    );
    await vi.advanceTimersByTimeAsync(1);
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: "ABORTED" });
    vi.useRealTimers();
  });
});

describe("parseModelRefString invalid", () => {
  it.each(["", "nope", "/", "/only", "only/", "a/"])((ref) => {
    expect(() => parseModelRefString(ref)).toThrow(LLMError);
  });
});

describe("buildCanonicalRequest", () => {
  it("builds from prompt only", () => {
    const r = buildCanonicalRequest({
      handle: modelRef("o", "m"),
      prompt: "p",
    });
    expect(r.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "p" }] },
    ]);
  });

  it("builds from prompt as MessagePart[] (multimodal)", () => {
    const r = buildCanonicalRequest({
      handle: modelRef("o", "m"),
      prompt: [
        { type: "text", text: "look" },
        { type: "image_url", url: "https://ex.com/i.png" },
      ],
    });
    expect(r.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", url: "https://ex.com/i.png" },
        ],
      },
    ]);
  });

  it("throws when prompt is empty MessagePart[]", () => {
    expect(() =>
      buildCanonicalRequest({
        handle: modelRef("o", "m"),
        prompt: [],
      }),
    ).toThrow(LLMError);
  });

  it("throws when neither prompt nor messages", () => {
    expect(() =>
      buildCanonicalRequest({ handle: modelRef("o", "m") }),
    ).toThrow(LLMError);
  });

  it("merges handle-only and call-only providerOptions", () => {
    const onlyHandle = buildCanonicalRequest({
      handle: modelRef("o", "m", { providerOptions: { only: "h" } }),
      prompt: "x",
    });
    expect(onlyHandle.providerOptions).toEqual({ only: "h" });
    const onlyCall = buildCanonicalRequest({
      handle: modelRef("o", "m"),
      prompt: "x",
      providerOptions: { only: "c" },
    });
    expect(onlyCall.providerOptions).toEqual({ only: "c" });
  });

  it("deep-merges providerOptions for same vendor key", () => {
    const r = buildCanonicalRequest({
      handle: modelRef("o", "m", {
        providerOptions: { openai: { a: 1, nested: { x: 1 } } },
      }),
      prompt: "x",
      providerOptions: { openai: { b: 2, nested: { y: 2 } } },
    });
    expect(r.providerOptions?.openai).toEqual({
      a: 1,
      b: 2,
      nested: { y: 2 },
    });
  });
});

describe("LLMRegistry", () => {
  it("rejects duplicate vendor", () => {
    const r = new LLMRegistry();
    const a = createEchoAdapter();
    r.register(a);
    expect(() => r.register(a)).toThrow(/already registered/);
  });

  it("allows overwrite", () => {
    const r = new LLMRegistry();
    r.register(createEchoAdapter(), { overwrite: true });
    r.register(createEchoAdapter(), { overwrite: true });
    expect(r.has("echo")).toBe(true);
  });

  it("get throws MODEL_NOT_FOUND for unknown vendor", () => {
    const r = new LLMRegistry();
    expect(() => r.get("missing")).toThrow(LLMError);
  });

  it("has returns false for missing", () => {
    const r = new LLMRegistry();
    expect(r.has("echo")).toBe(false);
  });
});

describe("createOpenAIAndAnthropicRegistry", () => {
  it("registers both vendors", () => {
    const r = createOpenAIAndAnthropicRegistry();
    expect(r.has("openai")).toBe(true);
    expect(r.has("anthropic")).toBe(true);
  });
});

describe("OpenAI adapter", () => {
  const adapter = createOpenAIAdapter();

  it("generateText success with usage and finish_reason length", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: "out" },
              finish_reason: "length",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const out = await adapter.generateText(
      {
        ...minimalReq,
        params: {
          temperature: 0.1,
          maxOutputTokens: 10,
          topP: 0.9,
          stopSequences: ["STOP"],
        },
        providerOptions: { openai: { seed: 42 } },
      },
      {
        ...ctx(fetchMock as typeof fetch),
        baseUrl: "https://api.example.com/v1/",
      },
    );
    expect(out.text).toBe("out");
    expect(out.finishReason).toBe("length");
    expect(out.usage?.totalTokens).toBe(3);
    const [reqUrl, init] = fetchMock.mock.calls[0]!;
    expect(String(reqUrl)).toContain("api.example.com/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    expect(body.temperature).toBe(0.1);
    expect(body.max_tokens).toBe(10);
    expect(body.top_p).toBe(0.9);
    expect(body.stop).toEqual(["STOP"]);
    expect(body.seed).toBe(42);
  });

  it("generateText uses content parts array when text-only", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    await adapter.generateText(minimalReq, ctx(fetchMock as typeof fetch));
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(body.messages[0]!.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("generateText maps multimodal user content to OpenAI parts array", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    await adapter.generateText(
      {
        modelId: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe" },
              {
                type: "image_url",
                url: "https://example.com/a.png",
                detail: "low",
              },
            ],
          },
        ],
        params: {},
      },
      ctx(fetchMock as typeof fetch),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(body.messages[0]!.content).toEqual([
      { type: "text", text: "describe" },
      {
        type: "image_url",
        image_url: { url: "https://example.com/a.png", detail: "low" },
      },
    ]);
  });

  it("maps 401 and 500 and 404 and INVALID_REQUEST", async () => {
    const a = createOpenAIAdapter();
    await expect(
      a.generateText(minimalReq, {
        ...ctx(
          vi
            .fn()
            .mockResolvedValue(
              new Response(JSON.stringify({ error: { message: "bad" } }), {
                status: 401,
              }),
            ) as typeof fetch,
        ),
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      a.generateText(minimalReq, {
        ...ctx(
          vi
            .fn()
            .mockResolvedValue(new Response("err", { status: 500 })) as typeof fetch,
        ),
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR", retryable: true });
    await expect(
      a.generateText(minimalReq, {
        ...ctx(
          vi
            .fn()
            .mockResolvedValue(
              new Response(JSON.stringify({ error: { message: "nf" } }), {
                status: 404,
              }),
            ) as typeof fetch,
        ),
      }),
    ).rejects.toMatchObject({ code: "MODEL_NOT_FOUND" });
    await expect(
      a.generateText(minimalReq, {
        ...ctx(
          vi
            .fn()
            .mockResolvedValue(new Response("x", { status: 400 })) as typeof fetch,
        ),
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("generateText maps TypeError to NETWORK", async () => {
    await expect(
      adapter.generateText(minimalReq, {
        ...ctx(vi.fn().mockRejectedValue(new TypeError("net")) as typeof fetch),
      }),
    ).rejects.toMatchObject({ code: "NETWORK", retryable: true });
  });

  it("generateText maps non-Error throw to UNKNOWN", async () => {
    await expect(
      adapter.generateText(minimalReq, {
        ...ctx(vi.fn().mockRejectedValue("boom") as typeof fetch),
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN" });
  });

  it("streamText returns chunks and skips bad JSON lines", async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"A"}}]}\n\n' +
      "data: not-json\n\n" +
      'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n' +
      "data: [DONE]\n\n";
    const fetchMock = vi.fn(async () => {
      return new Response(bytes(sse), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const iter = await adapter.streamText(minimalReq, {
      ...ctx(fetchMock as typeof fetch),
    });
    const parts: CanonicalStreamChunk[] = [];
    for await (const c of iter) parts.push(c);
    const text = parts
      .filter((p): p is Extract<typeof p, { type: "text-delta" }> => p.type === "text-delta")
      .map((p) => p.textDelta)
      .join("");
    expect(text).toBe("A");
    const fin = parts.find((p) => p.type === "finish");
    expect(fin?.type).toBe("finish");
    if (fin?.type === "finish") {
      expect(fin.finishReason).toBe("content_filter");
      expect(fin.usage?.totalTokens).toBe(2);
    }
  });

  it("streamText propagates HTTP errors", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ error: { message: "x" } }), {
        status: 429,
      });
    });
    await expect(
      adapter.streamText(minimalReq, {
        ...ctx(fetchMock as typeof fetch),
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMIT" });
  });

  it("streamText maps fetch TypeError", async () => {
    await expect(
      adapter.streamText(minimalReq, {
        ...ctx(vi.fn().mockRejectedValue(new TypeError("x")) as typeof fetch),
      }),
    ).rejects.toMatchObject({ code: "NETWORK" });
  });

  it("streamText rethrows LLMError from fetch", async () => {
    const err = new LLMError({
      code: "RATE_LIMIT",
      message: "x",
      retryable: true,
    });
    await expect(
      adapter.streamText(minimalReq, {
        ...ctx(vi.fn().mockRejectedValue(err) as typeof fetch),
      }),
    ).rejects.toBe(err);
  });

  it("streamText maps non-Error rejection to UNKNOWN", async () => {
    await expect(
      adapter.streamText(minimalReq, {
        ...ctx(vi.fn().mockRejectedValue("boom") as typeof fetch),
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN" });
  });

  it("mapError wraps unknown", () => {
    const e = adapter.mapError("x", { modelId: "m" });
    expect(e.code).toBe("UNKNOWN");
  });
});

describe("Anthropic adapter", () => {
  const adapter = createAnthropicAdapter();

  it("generateText success with system and usage", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "Hi" }],
          stop_reason: "max_tokens",
          usage: { input_tokens: 3, output_tokens: 4 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const out = await adapter.generateText(
      {
        modelId: "claude",
        messages: [
          { role: "system", content: [{ type: "text", text: "sys" }] },
          { role: "user", content: [{ type: "text", text: "u" }] },
        ],
        params: {
          temperature: 0.2,
          maxOutputTokens: 100,
          topP: 0.95,
          stopSequences: ["STOP"],
        },
        providerOptions: { anthropic: { metadata: { id: "1" } } },
      },
      {
        fetch: fetchMock as typeof fetch,
        apiKey: "k",
        vendorId: "anthropic",
        baseUrl: "https://api.anthropic.com/v1/",
      },
    );
    expect(out.text).toBe("Hi");
    expect(out.finishReason).toBe("length");
    expect(out.usage?.inputTokens).toBe(3);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.system).toBe("sys");
    expect(
      (body.messages as Array<{ role: string; content: unknown }>)[0]!
        .content,
    ).toEqual([{ type: "text", text: "u" }]);
    expect(body.max_tokens).toBe(100);
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.95);
    expect(body.stop_sequences).toEqual(["STOP"]);
    expect(body.metadata).toEqual({ id: "1" });
  });

  it("generateText maps user multimodal to Anthropic content blocks", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    await adapter.generateText(
      {
        modelId: "claude-3",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "see" },
              { type: "image_url", url: "https://example.com/i.jpg" },
            ],
          },
        ],
        params: {},
      },
      {
        fetch: fetchMock as typeof fetch,
        apiKey: "k",
        vendorId: "anthropic",
      },
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as {
      messages: Array<{ content: unknown }>;
    };
    expect(body.messages[0]!.content).toEqual([
      { type: "text", text: "see" },
      {
        type: "image",
        source: { type: "url", url: "https://example.com/i.jpg" },
      },
    ]);
  });

  it("rejects system messages with image parts", async () => {
    await expect(
      adapter.generateText(
        {
          modelId: "c",
          messages: [
            {
              role: "system",
              content: [
                { type: "text", text: "s" },
                { type: "image_url", url: "https://x.com/a.png" },
              ],
            },
            { role: "user", content: [{ type: "text", text: "u" }] },
          ],
          params: {},
        },
        {
          fetch: vi.fn() as typeof fetch,
          apiKey: "k",
          vendorId: "anthropic",
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("rejects assistant messages with image parts", async () => {
    await expect(
      adapter.generateText(
        {
          modelId: "c",
          messages: [
            { role: "user", content: [{ type: "text", text: "u" }] },
            {
              role: "assistant",
              content: [
                { type: "text", text: "a" },
                { type: "image_url", url: "https://x.com/b.png" },
              ],
            },
          ],
          params: {},
        },
        {
          fetch: vi.fn() as typeof fetch,
          apiKey: "k",
          vendorId: "anthropic",
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("throws when only system messages", async () => {
    await expect(
      adapter.generateText(
        {
          modelId: "c",
          messages: [{ role: "system", content: [{ type: "text", text: "s" }] }],
          params: {},
        },
        {
          fetch: vi.fn() as typeof fetch,
          apiKey: "k",
          vendorId: "anthropic",
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("defaults max_tokens when maxOutputTokens omitted", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "x" }],
          stop_reason: "end_turn",
        }),
        { status: 200 },
      );
    });
    await adapter.generateText(minimalReq, {
      fetch: fetchMock as typeof fetch,
      apiKey: "k",
      vendorId: "anthropic",
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body.max_tokens).toBe(4096);
  });

  it("streamText parses SSE pipeline", async () => {
    const sse =
      'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n' +
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Z"}}\n\n' +
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n';
    const fetchMock = vi.fn(async () => {
      return new Response(bytes(sse), { status: 200 });
    });
    const iter = await adapter.streamText(minimalReq, {
      fetch: fetchMock as typeof fetch,
      apiKey: "k",
      vendorId: "anthropic",
    });
    const parts: CanonicalStreamChunk[] = [];
    for await (const c of iter) parts.push(c);
    expect(parts.some((p) => p.type === "text-delta" && p.textDelta === "Z")).toBe(true);
    const fin = parts.find((p) => p.type === "finish");
    expect(fin?.type).toBe("finish");
    if (fin?.type === "finish") {
      expect(fin.usage?.inputTokens).toBe(5);
      expect(fin.usage?.outputTokens).toBe(2);
    }
  });

  it("generateText TypeError and mapError", async () => {
    await expect(
      adapter.generateText(minimalReq, {
        fetch: vi.fn().mockRejectedValue(new TypeError("n")) as typeof fetch,
        apiKey: "k",
        vendorId: "anthropic",
      }),
    ).rejects.toMatchObject({ code: "NETWORK" });
    expect(adapter.mapError("z", {}).code).toBe("UNKNOWN");
  });

  it("maps 403 to UNAUTHORIZED", async () => {
    await expect(
      adapter.generateText(minimalReq, {
        fetch: vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({ error: { message: "forbidden" } }), {
              status: 403,
            }),
          ) as typeof fetch,
        apiKey: "k",
        vendorId: "anthropic",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("maps stop_reason refusal to content_filter", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "no" }],
          stop_reason: "refusal",
        }),
        { status: 200 },
      );
    });
    const out = await adapter.generateText(minimalReq, {
      fetch: fetchMock as typeof fetch,
      apiKey: "k",
      vendorId: "anthropic",
    });
    expect(out.finishReason).toBe("content_filter");
  });

  it("streamText maps HTTP 500", async () => {
    await expect(
      adapter.streamText(minimalReq, {
        fetch: vi
          .fn()
          .mockResolvedValue(new Response("err", { status: 500 })) as typeof fetch,
        apiKey: "k",
        vendorId: "anthropic",
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("streamText maps non-TypeError rejection to UNKNOWN", async () => {
    await expect(
      adapter.streamText(minimalReq, {
        fetch: vi.fn().mockRejectedValue("x") as typeof fetch,
        apiKey: "k",
        vendorId: "anthropic",
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN" });
  });
});

describe("Echo adapter", () => {
  it("getCapabilities and mapError", () => {
    const a = createEchoAdapter();
    expect(a.getCapabilities().notes).toContain("Test-only");
    expect(a.mapError(new LLMError({ code: "X", message: "m", retryable: false }))).toBeInstanceOf(
      LLMError,
    );
    expect(a.mapError(new Error("e"), { modelId: "mid" }).code).toBe("UNKNOWN");
  });
});

describe("createLLMClient integration", () => {
  it("throws UNAUTHORIZED when API key missing", async () => {
    const client = createLLMClient({
      registry: createRegistry([createEchoAdapter()]),
      resolveApiKey: () => undefined,
    });
    await expect(
      client.generateText({ model: "echo/x", prompt: "a" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("includeRaw strips raw when false", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "x" }, finish_reason: "stop" }],
        }),
        { status: 200 },
      );
    });
    const client = createLLMClient({
      registry: createRegistry([createOpenAIAdapter()]),
      resolveApiKey: () => "k",
      fetch: fetchMock as typeof fetch,
    });
    const r = await client.generateText({
      model: "openai/gpt-4o-mini",
      prompt: "p",
      includeRaw: false,
    });
    expect(r.raw).toBeUndefined();
    const r2 = await client.generateText({
      model: "openai/gpt-4o-mini",
      prompt: "p",
      includeRaw: true,
    });
    expect(r2.raw).toBeDefined();
  });

  it("fires hooks, shouldRetry=false skips retries, and onStreamChunk", async () => {
    const onRequestStart = vi.fn();
    const onRequestEnd = vi.fn();
    const onRetry = vi.fn();
    const onStreamChunk = vi.fn(async () => {
      await Promise.resolve();
    });
    let attempt = 0;
    const fetchMock = vi.fn(async () => {
      attempt++;
      if (attempt < 2) {
        return new Response(JSON.stringify({ error: { message: "r" } }), {
          status: 429,
        });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        }),
        { status: 200 },
      );
    });
    const client = createLLMClient({
      registry: createRegistry([createOpenAIAdapter()]),
      resolveApiKey: () => "k",
      fetch: fetchMock as typeof fetch,
      hooks: {
        onRequestStart,
        onRequestEnd,
        onRetry,
        onStreamChunk,
      },
      shouldRetry: () => false,
    });
    await expect(
      client.generateText({
        model: "openai/gpt-4o-mini",
        prompt: "p",
        retry: { maxAttempts: 4, initialDelayMs: 0, jitterRatio: 0 },
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMIT" });
    expect(onRetry).not.toHaveBeenCalled();

    const reg = createRegistry([createEchoAdapter()]);
    const ic = createLLMClient({
      registry: reg,
      resolveApiKey: () => "k",
      hooks: {
        onRequestStart,
        onRequestEnd,
      },
    });
    await ic.generateText({ model: "echo/m", prompt: "h" });
    expect(onRequestStart).toHaveBeenCalled();
    expect(onRequestEnd).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, mode: "generate" }),
    );

    const ic2 = createLLMClient({
      registry: reg,
      resolveApiKey: () => "k",
      hooks: { onStreamChunk },
    });
    const st = await ic2.streamText({ model: "echo/m", prompt: "s" });
    for await (const c of st.textStream) {
      void c;
    }
    expect(onStreamChunk).toHaveBeenCalled();
  });

  it("streamText fails during connect and maps error", async () => {
    const client = createLLMClient({
      registry: createRegistry([createOpenAIAdapter()]),
      resolveApiKey: () => "k",
      fetch: vi.fn().mockRejectedValue(new Error("fail")) as typeof fetch,
    });
    await expect(
      client.streamText({ model: "openai/gpt-4o-mini", prompt: "p" }),
    ).rejects.toMatchObject({ code: "UNKNOWN" });
  });

  it("streamText fails mid-iteration", async () => {
    const throwingAdapter: LLMAdapter = {
      vendorId: "throwmid",
      async generateText() {
        throw new Error("no");
      },
      async streamText() {
        async function* gen(): AsyncGenerator<CanonicalStreamChunk> {
          yield { type: "text-delta", textDelta: "a" };
          throw new Error("mid");
        }
        return gen();
      },
      getCapabilities() {
        return {
          streaming: true,
          supportsTopP: true,
          supportsStopSequences: true,
        };
      },
      mapError(e) {
        return LLMError.isInstance(e)
          ? e
          : new LLMError({
              code: "UNKNOWN",
              message: e instanceof Error ? e.message : String(e),
              retryable: false,
            });
      },
    };
    const client = createLLMClient({
      registry: createRegistry([throwingAdapter]),
      resolveApiKey: () => "k",
    });
    const { textStream, text, finishReason } = await client.streamText({
      model: "throwmid/x",
      prompt: "p",
    });
    await expect(
      (async () => {
        for await (const _ of textStream) {
          /* drain */
        }
      })(),
    ).rejects.toThrow();
    await expect(text).rejects.toBeDefined();
    await expect(finishReason).resolves.toBe("error");
  });

  it("invokes onWarning from adapter context", async () => {
    const onWarning = vi.fn();
    const warnAdapter: LLMAdapter = {
      vendorId: "warn",
      async generateText(_req, c) {
        c.onWarning?.("w");
        return { text: "t", finishReason: "stop" };
      },
      async streamText() {
        async function* g(): AsyncGenerator<CanonicalStreamChunk> {
          yield { type: "finish", finishReason: "stop" };
        }
        return g();
      },
      getCapabilities() {
        return {
          streaming: true,
          supportsTopP: true,
          supportsStopSequences: true,
        };
      },
      mapError(e) {
        return LLMError.isInstance(e)
          ? e
          : new LLMError({
              code: "UNKNOWN",
              message: String(e),
              retryable: false,
            });
      },
    };
    const client = createLLMClient({
      registry: createRegistry([warnAdapter]),
      resolveApiKey: () => "k",
      hooks: { onWarning: (i) => onWarning(i.message) },
    });
    await client.generateText({ model: "warn/m", prompt: "p" });
    expect(onWarning).toHaveBeenCalledWith("w");
  });

  it("generateText propagates LLMError without remapping", async () => {
    const badAdapter: LLMAdapter = {
      vendorId: "bad",
      async generateText() {
        throw new LLMError({
          code: "INVALID_REQUEST",
          message: "direct",
          retryable: false,
        });
      },
      async streamText() {
        async function* g(): AsyncGenerator<CanonicalStreamChunk> {
          yield { type: "finish", finishReason: "stop" };
        }
        return g();
      },
      getCapabilities() {
        return {
          streaming: true,
          supportsTopP: true,
          supportsStopSequences: true,
        };
      },
      mapError(e) {
        return LLMError.isInstance(e)
          ? e
          : new LLMError({
              code: "UNKNOWN",
              message: String(e),
              retryable: false,
            });
      },
    };
    const client = createLLMClient({
      registry: createRegistry([badAdapter]),
      resolveApiKey: () => "k",
    });
    await expect(
      client.generateText({ model: "bad/m", prompt: "p" }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", message: "direct" });
  });

  it("uses baseUrlByVendor and defaultTimeoutMs", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "x" }, finish_reason: "stop" }],
        }),
        { status: 200 },
      );
    });
    const client = createLLMClient({
      registry: createRegistry([createOpenAIAdapter()]),
      resolveApiKey: () => "k",
      fetch: fetchMock as typeof fetch,
      baseUrlByVendor: { openai: "https://custom.example/v1" },
      defaultTimeoutMs: 30_000,
    });
    await client.generateText({ model: "openai/gpt-4o-mini", prompt: "p" });
    expect(String(fetchMock.mock.calls[0]![0])).toContain("custom.example");
  });
});

describe("barrel re-exports", () => {
  it("llm/index exposes core APIs", async () => {
    const Llm = await import("./index");
    expect(typeof Llm.createLLMClient).toBe("function");
    expect(typeof Llm.createEchoAdapter).toBe("function");
    expect(Llm.toPublicMessage("UNKNOWN")).toBeDefined();
  });

  it("package root re-exports LLM", async () => {
    const Root = await import("../index");
    expect(typeof Root.createLLMClient).toBe("function");
    expect(typeof Root.modelRef).toBe("function");
  });
});
