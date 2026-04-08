import { describe, expect, it, vi } from "vitest";
import { createAnthropicAdapter } from "../adapters/anthropic-adapter";
import { LLMError } from "../errors";
import type { CanonicalStreamChunk } from "../types";
import { bytes, minimalReq } from "./test-helpers";

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
        providerOptions: { metadata: { id: "1" } },
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
    expect((body.messages as Array<{ role: string; content: unknown }>)[0]!.content).toEqual([
      { type: "text", text: "u" },
    ]);
    expect(body.max_tokens).toBe(100);
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.95);
    expect(body.stop_sequences).toEqual(["STOP"]);
    expect(body.metadata).toEqual({ id: "1" });
  });

  it("rejects providerOptions collisions with Anthropic reserved fields", async () => {
    await expect(
      adapter.generateText(
        {
          modelId: "claude",
          messages: [{ role: "user", content: [{ type: "text", text: "u" }] }],
          params: {},
          providerOptions: { stream: false },
        },
        {
          fetch: vi.fn() as typeof fetch,
          apiKey: "k",
          vendorId: "anthropic",
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
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
    expect(body.max_tokens).toBe(8192);
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
        fetch: vi.fn().mockResolvedValue(
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
        fetch: vi.fn().mockResolvedValue(new Response("err", { status: 500 })) as typeof fetch,
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
