import { describe, expect, it, vi } from "vitest";
import { createAnthropicAdapter } from "../adapters/anthropic-adapter";
import { createEchoAdapter } from "../adapters/echo-adapter";
import { createOpenAIAdapter } from "../adapters/openai-adapter";
import { buildCanonicalRequest } from "../build-canonical-request";
import { createLLMClient } from "../client";
import { createDefaultLLMClient } from "../default-client";
import { openai } from "../vendor-models";
import { LLMError, RetryableError } from "../errors";
import { modelRef, parseModelRefString } from "../model-ref";
import { createRegistry } from "../registry";
import { defaultRetryPolicy, executeWithRetry } from "../retry";

describe("createDefaultLLMClient + vendor-models", () => {
  it("works with echo registry and static key", async () => {
    const client = createDefaultLLMClient({
      registry: createRegistry([createEchoAdapter()]),
      useEnv: false,
      apiKeys: { echo: "k" },
    });
    const r = await client.generateText({
      model: "echo/test",
      prompt: "hi",
    });
    expect(r.text).toBe("echo:hi");
  });

  it("openai() builds openai/model ref string", () => {
    expect(openai("gpt-4o-mini")).toBe("openai/gpt-4o-mini");
  });
});

describe("parseModelRefString", () => {
  it("parses vendor/model", () => {
    expect(parseModelRefString("openai/gpt-4o")).toEqual({
      vendorId: "openai",
      modelId: "gpt-4o",
    });
  });
});

describe("buildCanonicalRequest", () => {
  it("prefers messages over prompt", () => {
    const req = buildCanonicalRequest({
      handle: modelRef("openai", "gpt-4o"),
      prompt: "ignored",
      messages: [{ role: "user", content: [{ type: "text", text: "from messages" }] }],
    });
    expect(req.messages[0]?.content[0]?.text).toBe("from messages");
  });
});

describe("createLLMClient with echo adapter", () => {
  it("generateText with multimodal prompt", async () => {
    const registry = createRegistry([createEchoAdapter()]);
    const client = createLLMClient({
      registry,
      resolveApiKey: () => "x",
    });
    const r = await client.generateText({
      model: modelRef("echo", "x"),
      prompt: [
        { type: "text", text: "see " },
        { type: "image_url", url: "https://a.com/b.jpg" },
      ],
    });
    expect(r.text).toBe("echo:see [image:url:https://a.com/b.jpg]");
  });

  it("generateText", async () => {
    const registry = createRegistry([createEchoAdapter()]);
    const client = createLLMClient({
      registry,
      resolveApiKey: () => "x",
    });
    const r = await client.generateText({
      model: modelRef("echo", "x"),
      prompt: "hi",
    });
    expect(r.text).toBe("echo:hi");
  });

  it("streamText resolves text after consumption", async () => {
    const registry = createRegistry([createEchoAdapter()]);
    const client = createLLMClient({
      registry,
      resolveApiKey: () => "x",
    });
    const { textStream, text, finishReason } = await client.streamText({
      model: "echo/test",
      prompt: "a",
    });
    let deltas = "";
    for await (const c of textStream) {
      if (c.type === "text-delta") deltas += c.textDelta;
    }
    expect(deltas).toBe("echo:a");
    await expect(text).resolves.toBe("echo:a");
    await expect(finishReason).resolves.toBe("stop");
  });
});

describe("createLLMClient multimodal", () => {
  it("echo: image, speech, transcribe, video, job, download", async () => {
    const client = createLLMClient({
      registry: createRegistry([createEchoAdapter()]),
      resolveApiKey: () => "x",
    });
    const img = await client.generateImage({
      model: "echo/m",
      prompt: "a cat",
    });
    expect(img.images[0]?.url).toMatch(/^echo:\/\/image/);

    const tr = await client.transcribe({
      model: "echo/m",
      audio: new TextEncoder().encode("hello"),
    });
    expect(tr.text).toContain("transcribed:");

    const speech = await client.textToSpeech({
      model: "echo/m",
      text: "hi",
    });
    expect(speech.audio.length).toBeGreaterThan(0);

    const vid = await client.generateVideo({ model: "echo/m", prompt: "p" });
    expect(vid.videoId).toContain("echo_vid_");

    const job = await client.getVideoJob({ model: "echo/m", videoId: "x" });
    expect(job.status).toBe("completed");
    expect(job.fileId).toBeDefined();

    const bin = await client.downloadVideo({ model: "echo/m", videoId: "x" });
    expect(bin.data.length).toBeGreaterThan(0);

    const bin2 = await client.downloadVideo({
      model: "echo/m",
      fileId: job.fileId,
    });
    expect(bin2.data.length).toBeGreaterThan(0);
  });

  it("anthropic generateImage is NOT_IMPLEMENTED", async () => {
    const client = createLLMClient({
      registry: createRegistry([createAnthropicAdapter()]),
      resolveApiKey: () => "k",
    });
    await expect(
      client.generateImage({
        model: "anthropic/claude-3-5-sonnet-20241022",
        prompt: "x",
      }),
    ).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
  });
});

describe("executeWithRetry", () => {
  it("retries retryable errors", async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      n++;
      if (n < 3) {
        throw new RetryableError({
          code: "RATE_LIMIT",
          message: "slow",
          vendor: "t",
        });
      }
      return "ok";
    });
    const r = await executeWithRetry(fn, {
      policy: {
        ...defaultRetryPolicy,
        maxAttempts: 5,
        initialDelayMs: 0,
        jitterRatio: 0,
      },
      isRetryable: (e) => LLMError.isInstance(e) && e.retryable,
    });
    expect(r).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe("OpenAI adapter with mock fetch", () => {
  it("maps 429 to RATE_LIMIT retryable", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "rate" } }), {
          status: 429,
        }),
    );
    const adapter = createOpenAIAdapter();
    await expect(
      adapter.generateText(
        {
          modelId: "gpt-4o-mini",
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          params: {},
        },
        {
          fetch: fetchMock as typeof fetch,
          apiKey: "k",
          vendorId: "openai",
        },
      ),
    ).rejects.toMatchObject({ code: "RATE_LIMIT", retryable: true });
  });
});
