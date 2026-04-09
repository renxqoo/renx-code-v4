import { describe, expect, it, vi } from "vitest";
import { createEchoAdapter } from "../adapters/echo-adapter";
import { createOpenAIAdapter } from "../adapters/openai-adapter";
import { createLLMClient } from "../client";
import { LLMError } from "../errors";
import { createRegistry } from "../registry";
import type { LLMAdapter } from "../adapter";
import type { CanonicalStreamChunk } from "../types";

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
    await expect(client.generateText({ model: "echo/x", prompt: "a" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
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

  it("strictParams rejects streamText when adapter does not support streaming", async () => {
    const nonStreamingAdapter: LLMAdapter = {
      vendorId: "nostream",
      async generateText() {
        return { text: "ok", finishReason: "stop" };
      },
      async streamText() {
        async function* gen(): AsyncGenerator<CanonicalStreamChunk> {
          yield { type: "finish", finishReason: "stop" };
        }
        return gen();
      },
      getCapabilities() {
        return {
          streaming: false,
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
      registry: createRegistry([nonStreamingAdapter]),
      resolveApiKey: () => "k",
      strictParams: true,
    });

    await expect(client.streamText({ model: "nostream/x", prompt: "p" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      message: "nostream/x does not support streaming",
    });
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
    await expect(client.generateText({ model: "bad/m", prompt: "p" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      message: "direct",
    });
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
    const Llm = await import("../index");
    expect(typeof Llm.createLLMClient).toBe("function");
    expect(typeof Llm.createEchoAdapter).toBe("function");
    expect(Llm.toPublicMessage("UNKNOWN")).toBeDefined();
  });

  it("package root re-exports LLM", async () => {
    const Root = await import("../../index");
    expect(typeof Root.createLLMClient).toBe("function");
    expect(typeof Root.modelRef).toBe("function");
  });
});
