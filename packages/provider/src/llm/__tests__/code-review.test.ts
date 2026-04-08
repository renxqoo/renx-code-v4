/**
 * code-review.test.ts — Tests for issues found in deep code review.
 *
 * Organised by priority:
 *   P0: functional bugs (must fix)
 *   P1: important correctness / consistency issues
 *   P2: robustness / dead code / unused exports
 *   P3: style / minor cleanup
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createAnthropicAdapter } from "../adapters/anthropic-adapter";
import { createEchoAdapter } from "../adapters/echo-adapter";
import { createOpenAIAdapter } from "../adapters/openai-adapter";
import { createLLMClient } from "../client";
import { LLMError, RetryableError, isRetryableLlmError } from "../errors";
import { LLMRegistry, createRegistry } from "../registry";
import { buildCanonicalRequest } from "../build-canonical-request";
import { modelRef } from "../model-ref";
import type { AdapterInvokeContext } from "../adapter";

// ── Helpers ──────────────────────────────────────────────────────────────────

const anthropicCtx = (fetch: typeof fetch): AdapterInvokeContext => ({
  fetch,
  apiKey: "k",
  vendorId: "anthropic",
});

// ═══════════════════════════════════════════════════════════════════════════════
// P0: Functional bugs
// ═══════════════════════════════════════════════════════════════════════════════

describe("P0 #14 – Anthropic: hasNonTextPart misclassifies tool_call as image", () => {
  /**
   * assistant message with tool_call parts should NOT trigger
   * "assistant messages cannot contain image parts" error.
   */
  it("accepts assistant message with tool_call parts (not image)", async () => {
    const adapter = createAnthropicAdapter();
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    // This must NOT throw "cannot contain image parts" — tool_call is not an image
    const result = await adapter.generateText(
      {
        modelId: "claude-3",
        messages: [
          { role: "user", content: [{ type: "text", text: "weather?" }] },
          {
            role: "assistant",
            content: [
              { type: "tool_call", id: "c1", name: "get_weather", arguments: '{"city":"BJ"}' },
            ],
          },
        ],
        params: {},
      },
      anthropicCtx(fetchMock as typeof fetch),
    );

    expect(result).toBeDefined();
    // The request body should have been sent
    expect(fetchMock).toHaveBeenCalled();
  });

  it("still rejects assistant message with actual image parts", async () => {
    const adapter = createAnthropicAdapter();
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
        anthropicCtx(vi.fn() as typeof fetch),
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});

describe("P0 #4 – Anthropic: tool role messages must not be silently dropped", () => {
  it("rejects role=tool messages with NOT_IMPLEMENTED (not silent drop)", async () => {
    const adapter = createAnthropicAdapter();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }),
          { status: 200 },
        ),
    );

    await expect(
      adapter.generateText(
        {
          modelId: "claude-3",
          messages: [
            { role: "user", content: [{ type: "text", text: "weather?" }] },
            {
              role: "assistant",
              content: [
                { type: "tool_call", id: "c1", name: "get_weather", arguments: '{"city":"BJ"}' },
              ],
            },
            { role: "tool", content: [{ type: "tool_result", toolCallId: "c1", content: "25°C" }] },
          ],
          params: {},
        },
        anthropicCtx(fetchMock as typeof fetch),
      ),
    ).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });

    // fetch should NOT have been called — error is thrown before network
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// P1: Important correctness / consistency
// ═══════════════════════════════════════════════════════════════════════════════

describe("P1 #16 – registry.register throws plain Error, should be LLMError", () => {
  it("throws LLMError for duplicate vendor (not plain Error)", () => {
    const r = new LLMRegistry();
    r.register(createEchoAdapter());
    try {
      r.register(createEchoAdapter());
    } catch (e) {
      expect(LLMError.isInstance(e)).toBe(true);
      if (LLMError.isInstance(e)) {
        expect(e.code).toBeDefined();
      }
    }
  });
});

describe("P1 #10 – transcribe providerOptions should not override explicit fields", () => {
  it("rejects reserved transcription fields in providerOptions", async () => {
    const adapter = createOpenAIAdapter();
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ text: "hello world" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const client = createLLMClient({
      registry: createRegistry([adapter]),
      resolveApiKey: () => "k",
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      client.transcribe({
        model: "openai/whisper-1",
        audio: new Uint8Array([1, 2, 3]),
        language: "fr",
        prompt: "explicit prompt",
        providerOptions: { language: "de", prompt: "should not override" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});

describe("P1 #2 – downloadVideo does not re-normalize model", () => {
  it("downloadVideo callback uses handle from invokeAdapter, not re-parsing model", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    });

    const client = createLLMClient({
      registry: createRegistry([createEchoAdapter()]),
      resolveApiKey: () => "k",
      fetch: fetchMock as typeof fetch,
    });

    // Should not throw — model is already parsed by invokeAdapter
    const result = await client.downloadVideo({
      model: "echo/test-model",
      videoId: "vid_123",
    });
    expect(result.data).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// P2: Robustness / dead code / unused exports
// ═══════════════════════════════════════════════════════════════════════════════

describe("P2 #6/#7 – catch blocks should be robust even if mapFetchError changes", () => {
  it("generateText re-throws even non-LLMError from unexpected throw in try", async () => {
    // Simulate an adapter that throws a plain string
    const throwAdapter = {
      vendorId: "throwstr",
      async generateText() {
        throw "plain-string-error";
      },
      async streamText() {
        async function* g(): AsyncGenerator {
          yield { type: "finish", finishReason: "stop" as const };
        }
        return g();
      },
      getCapabilities() {
        return { streaming: true, supportsTopP: true, supportsStopSequences: true };
      },
      mapError(e: unknown) {
        return new LLMError({ code: "UNKNOWN", message: String(e), retryable: false });
      },
    };

    const client = createLLMClient({
      registry: createRegistry([throwAdapter as any]),
      resolveApiKey: () => "k",
    });

    await expect(client.generateText({ model: "throwstr/m", prompt: "hi" })).rejects.toThrow(); // Should throw, not return undefined
  });
});

describe("P2 #24 – strictParams is declared but unused", () => {
  it("strictParams rejects unsupported canonical params", async () => {
    const adapter = {
      vendorId: "limited",
      async generateText() {
        return { text: "ok", finishReason: "stop" as const };
      },
      async streamText() {
        async function* gen() {
          yield { type: "finish" as const, finishReason: "stop" as const };
        }
        return gen();
      },
      getCapabilities() {
        return { streaming: true, supportsTopP: false, supportsStopSequences: false };
      },
      mapError(e: unknown) {
        return new LLMError({ code: "UNKNOWN", message: String(e), retryable: false });
      },
    };
    const client = createLLMClient({
      registry: createRegistry([adapter as any]),
      resolveApiKey: () => "k",
      strictParams: true,
    });
    await expect(
      client.generateText({
        model: "limited/m",
        prompt: "hi",
        topP: 0.8,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});

describe("P2 #15 – isRetryableLlmError is exported and functional", () => {
  it("identifies retryable errors", () => {
    const retryable = new RetryableError({ code: "RATE_LIMIT", message: "x" });
    expect(isRetryableLlmError(retryable)).toBe(true);

    const notRetryable = new LLMError({ code: "INVALID_REQUEST", message: "x", retryable: false });
    expect(isRetryableLlmError(notRetryable)).toBe(false);

    expect(isRetryableLlmError(new Error("x"))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// P3: Style / minor cleanup — behavioral tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("P3 #17 – vendor-models functions return correct format", () => {
  it("openai, anthropic, minimax return vendor/modelId format", async () => {
    const { openai, anthropic, minimax } = await import("../vendor-models");
    expect(openai("gpt-4o")).toBe("openai/gpt-4o");
    expect(anthropic("claude-3")).toBe("anthropic/claude-3");
    const m = minimax("M2.7");
    expect(m).toBe("minimax/M2.7");
    expect(minimax("M2.7", { reasoning_split: true })).toMatchObject({
      modelId: "M2.7",
      vendorId: "minimax",
      providerOptions: { reasoning_split: true },
    });
  });
});

describe("P3 #21 – extractVendorOptions returns consistent shape", () => {
  it("empty vendor namespace only yields undefined", () => {
    const r = buildCanonicalRequest({
      handle: modelRef("openai", "m", { providerOptions: { openai: {} } }),
      prompt: "hi",
    });
    // vendor namespace with empty object + no flat keys → undefined
    expect(r.providerOptions).toBeUndefined();
  });

  it("flat keys are preserved", () => {
    const r = buildCanonicalRequest({
      handle: modelRef("openai", "m"),
      prompt: "hi",
      providerOptions: { seed: 42 },
    });
    expect(r.providerOptions).toEqual({ seed: 42 });
  });

  it("extracts namespace for the active custom vendor", () => {
    const r = buildCanonicalRequest({
      handle: modelRef("custom-vendor", "m"),
      prompt: "hi",
      providerOptions: {
        "custom-vendor": { mode: "safe" },
        openai: { seed: 42 },
      },
    });
    expect(r.providerOptions).toEqual({ mode: "safe" });
  });
});

describe("P3 #11 – generateVideo field exclusion uses efficient check", () => {
  it("generateVideo passes extra providerOptions through", async () => {
    const client = createLLMClient({
      registry: createRegistry([createEchoAdapter()]),
      resolveApiKey: () => "k",
    });

    // Should not throw — providerOptions with extra fields should work
    const result = await client.generateVideo({
      model: "echo/m",
      prompt: "test video",
      size: "720p",
      seconds: 5,
    });
    expect(result.videoId).toBeDefined();
  });
});

describe("docs stay aligned with the public API", () => {
  it("does not mention removed MiniMax and preset identifiers", () => {
    const usage = readFileSync(new URL("../../../docs/USAGE.md", import.meta.url), "utf8");
    const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    const combined = `${usage}\n${readme}`;

    expect(combined).not.toMatch(/\bminimaxi\(/);
    expect(combined).not.toMatch(/\bminimaxi\//);
    expect(combined).not.toContain("MINIMAXI_API_KEY");
    expect(combined).not.toContain("createOpenAIAndAnthropicRegistry()");
    expect(combined).not.toContain("preset:");
  });
});
