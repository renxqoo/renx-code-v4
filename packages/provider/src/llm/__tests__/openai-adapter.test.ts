import { describe, expect, it, vi } from "vitest";
import { createOpenAIAdapter } from "../adapters/openai-adapter";
import { buildCanonicalRequest } from "../build-canonical-request";
import { createLLMClient } from "../client";
import { LLMError } from "../errors";
import { modelRef } from "../model-ref";
import { createRegistry } from "../registry";
import type { CanonicalStreamChunk } from "../types";
import { bytes, minimalReq, openaiCtx } from "./test-helpers";

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
        providerOptions: { seed: 42 },
      },
      {
        ...openaiCtx(fetchMock as typeof fetch),
        baseUrl: "https://api.example.com",
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
    await adapter.generateText(minimalReq, openaiCtx(fetchMock as typeof fetch));
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
      openaiCtx(fetchMock as typeof fetch),
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

  it("rejects providerOptions collisions with reserved protocol fields", async () => {
    await expect(
      adapter.generateText(
        {
          ...minimalReq,
          providerOptions: { stream: false },
        },
        openaiCtx(vi.fn() as typeof fetch),
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("maps 401 and 500 and 404 and INVALID_REQUEST", async () => {
    const a = createOpenAIAdapter();
    await expect(
      a.generateText(minimalReq, {
        ...openaiCtx(
          vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ error: { message: "bad" } }), {
              status: 401,
            }),
          ) as typeof fetch,
        ),
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      a.generateText(minimalReq, {
        ...openaiCtx(
          vi.fn().mockResolvedValue(new Response("err", { status: 500 })) as typeof fetch,
        ),
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR", retryable: true });
    await expect(
      a.generateText(minimalReq, {
        ...openaiCtx(
          vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ error: { message: "nf" } }), {
              status: 404,
            }),
          ) as typeof fetch,
        ),
      }),
    ).rejects.toMatchObject({ code: "MODEL_NOT_FOUND" });
    await expect(
      a.generateText(minimalReq, {
        ...openaiCtx(
          vi.fn().mockResolvedValue(new Response("x", { status: 400 })) as typeof fetch,
        ),
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("generateText maps TypeError to NETWORK", async () => {
    await expect(
      adapter.generateText(minimalReq, {
        ...openaiCtx(vi.fn().mockRejectedValue(new TypeError("net")) as typeof fetch),
      }),
    ).rejects.toMatchObject({ code: "NETWORK", retryable: true });
  });

  it("generateText maps non-Error throw to UNKNOWN", async () => {
    await expect(
      adapter.generateText(minimalReq, {
        ...openaiCtx(vi.fn().mockRejectedValue("boom") as typeof fetch),
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
    const iter = await adapter.streamText(minimalReq, openaiCtx(fetchMock as typeof fetch));
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
    await expect(adapter.streamText(minimalReq, openaiCtx(fetchMock as typeof fetch))).rejects.toMatchObject({
      code: "RATE_LIMIT",
    });
  });

  it("streamText maps fetch TypeError", async () => {
    await expect(
      adapter.streamText(minimalReq, {
        ...openaiCtx(vi.fn().mockRejectedValue(new TypeError("x")) as typeof fetch),
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
        ...openaiCtx(vi.fn().mockRejectedValue(err) as typeof fetch),
      }),
    ).rejects.toBe(err);
  });

  it("streamText maps non-Error rejection to UNKNOWN", async () => {
    await expect(
      adapter.streamText(minimalReq, {
        ...openaiCtx(vi.fn().mockRejectedValue("boom") as typeof fetch),
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN" });
  });

  it("mapError wraps unknown", () => {
    const e = adapter.mapError("x", { modelId: "m" });
    expect(e.code).toBe("UNKNOWN");
  });

  it("generateText returns toolCalls when present", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: { name: "get_weather", arguments: '{"city":"Beijing"}' },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const out = await adapter.generateText!(
      {
        modelId: "gpt-4o",
        messages: [{ role: "user", content: [{ type: "text", text: "weather?" }] }],
        params: {},
        tools: [
          { name: "get_weather", description: "Get weather", parameters: { type: "object" } },
        ],
      },
      { fetch: fetchMock as typeof fetch, apiKey: "k", vendorId: "openai" },
    );
    expect(out.finishReason).toBe("tool_calls");
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls![0]).toEqual({
      id: "call_1",
      name: "get_weather",
      arguments: '{"city":"Beijing"}',
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe("get_weather");
  });

  it("streamText yields tool-call-delta chunks and aggregates toolCalls", async () => {
    const sseChunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"cit' } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'y":"BJ"}' } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}`,
      "data: [DONE]",
    ].join("\n\n");
    const stream = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode(sseChunks));
        ctrl.close();
      },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const client = createLLMClient({
      registry: createRegistry([adapter]),
      resolveApiKey: () => "k",
      fetch: fetchMock as typeof fetch,
    });
    const { textStream, toolCalls, finishReason } = await client.streamText({
      model: "openai/gpt-4o",
      prompt: "weather?",
      tools: [{ name: "get_weather", description: "Get weather" }],
    });
    const deltas: unknown[] = [];
    for await (const c of textStream) {
      if (c.type === "tool-call-delta") deltas.push(c);
    }
    expect(deltas.length).toBeGreaterThanOrEqual(3);
    expect(deltas[0]).toMatchObject({
      type: "tool-call-delta",
      index: 0,
      id: "call_1",
      name: "get_weather",
    });
    const calls = await toolCalls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ id: "call_1", name: "get_weather", arguments: '{"city":"BJ"}' });
    expect(await finishReason).toBe("tool_calls");
  });

  it("buildBody maps tool_call and tool_result messages for OpenAI format", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    await adapter.generateText!(
      {
        modelId: "gpt-4o",
        params: {},
        messages: [
          { role: "user", content: [{ type: "text", text: "weather?" }] },
          {
            role: "assistant",
            content: [
              { type: "tool_call", id: "call_1", name: "get_weather", arguments: '{"city":"BJ"}' },
            ],
          },
          {
            role: "tool",
            content: [{ type: "tool_result", toolCallId: "call_1", content: "25°C sunny" }],
          },
        ],
      },
      { fetch: fetchMock as typeof fetch, apiKey: "k", vendorId: "openai" },
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    const msgs = body.messages;
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].tool_calls).toHaveLength(1);
    expect(msgs[1].tool_calls[0].id).toBe("call_1");
    expect(msgs[2].role).toBe("tool");
    expect(msgs[2].tool_call_id).toBe("call_1");
    expect(msgs[2].content).toBe("25°C sunny");
  });

  it("generateText without tools has no toolCalls", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "just text" }, finish_reason: "stop" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const out = await adapter.generateText!(
      {
        modelId: "gpt-4o",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        params: {},
      },
      { fetch: fetchMock as typeof fetch, apiKey: "k", vendorId: "openai" },
    );
    expect(out.text).toBe("just text");
    expect(out.toolCalls).toBeUndefined();
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it("generateText handles multiple tool_calls in one response", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: { name: "get_weather", arguments: '{"city":"BJ"}' },
                    },
                    {
                      id: "call_2",
                      type: "function",
                      function: { name: "get_time", arguments: '{"tz":"Asia/Shanghai"}' },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const out = await adapter.generateText!(
      {
        modelId: "gpt-4o",
        messages: [{ role: "user", content: [{ type: "text", text: "weather and time in BJ" }] }],
        params: {},
        tools: [
          { name: "get_weather", description: "Get weather" },
          { name: "get_time", description: "Get time" },
        ],
      },
      { fetch: fetchMock as typeof fetch, apiKey: "k", vendorId: "openai" },
    );
    expect(out.finishReason).toBe("tool_calls");
    expect(out.toolCalls).toHaveLength(2);
    expect(out.toolCalls![0]).toEqual({
      id: "call_1",
      name: "get_weather",
      arguments: '{"city":"BJ"}',
    });
    expect(out.toolCalls![1]).toEqual({
      id: "call_2",
      name: "get_time",
      arguments: '{"tz":"Asia/Shanghai"}',
    });
  });

  it("generateText maps tool_choice into request body", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    await adapter.generateText!(
      {
        modelId: "gpt-4o",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        params: {},
        tools: [{ name: "f", description: "d" }],
        toolChoice: "auto",
      },
      { fetch: fetchMock as typeof fetch, apiKey: "k", vendorId: "openai" },
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body.tool_choice).toBe("auto");
  });

  it("generateText maps tool_choice with named function", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    await adapter.generateText!(
      {
        modelId: "gpt-4o",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        params: {},
        tools: [{ name: "my_func", description: "d" }],
        toolChoice: { type: "function", name: "my_func" },
      },
      { fetch: fetchMock as typeof fetch, apiKey: "k", vendorId: "openai" },
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body.tool_choice).toEqual({ type: "function", name: "my_func" });
  });

  it("generateText tools field maps description and parameters", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    await adapter.generateText!(
      {
        modelId: "gpt-4o",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        params: {},
        tools: [
          {
            name: "search",
            description: "Search the web",
            parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
          },
        ],
      },
      { fetch: fetchMock as typeof fetch, apiKey: "k", vendorId: "openai" },
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toEqual({
      type: "function",
      function: {
        name: "search",
        description: "Search the web",
        parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      },
    });
  });

  it("generateText handles empty tool_calls array gracefully", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: "no tools needed", tool_calls: [] }, finish_reason: "stop" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const out = await adapter.generateText!(
      {
        modelId: "gpt-4o",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        params: {},
        tools: [{ name: "f", description: "d" }],
      },
      { fetch: fetchMock as typeof fetch, apiKey: "k", vendorId: "openai" },
    );
    expect(out.text).toBe("no tools needed");
    expect(out.toolCalls).toBeUndefined();
  });

  it("assistant with both text and tool_calls maps content correctly", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    await adapter.generateText!(
      {
        modelId: "gpt-4o",
        params: {},
        messages: [
          { role: "user", content: [{ type: "text", text: "weather?" }] },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Let me check." },
              { type: "tool_call", id: "call_1", name: "get_weather", arguments: '{"city":"BJ"}' },
            ],
          },
          {
            role: "tool",
            content: [{ type: "tool_result", toolCallId: "call_1", content: "25°C" }],
          },
        ],
      },
      { fetch: fetchMock as typeof fetch, apiKey: "k", vendorId: "openai" },
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    const assistantMsg = body.messages[1];
    expect(assistantMsg.content).toBe("Let me check.");
    expect(assistantMsg.tool_calls).toHaveLength(1);
    expect(assistantMsg.tool_calls[0].function.name).toBe("get_weather");
  });

  it("multi-turn tool calling round-trip maps correctly", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "final answer" }, finish_reason: "stop" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    await adapter.generateText!(
      {
        modelId: "gpt-4o",
        params: {},
        messages: [
          { role: "user", content: [{ type: "text", text: "weather in BJ and SH?" }] },
          {
            role: "assistant",
            content: [
              { type: "tool_call", id: "call_a", name: "get_weather", arguments: '{"city":"BJ"}' },
              { type: "tool_call", id: "call_b", name: "get_weather", arguments: '{"city":"SH"}' },
            ],
          },
          {
            role: "tool",
            content: [{ type: "tool_result", toolCallId: "call_a", content: "BJ: 25°C" }],
          },
          {
            role: "tool",
            content: [{ type: "tool_result", toolCallId: "call_b", content: "SH: 22°C" }],
          },
        ],
      },
      { fetch: fetchMock as typeof fetch, apiKey: "k", vendorId: "openai" },
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    const msgs = body.messages;
    expect(msgs[1].tool_calls).toHaveLength(2);
    expect(msgs[1].tool_calls[0].id).toBe("call_a");
    expect(msgs[1].tool_calls[1].id).toBe("call_b");
    expect(msgs[2].role).toBe("tool");
    expect(msgs[2].tool_call_id).toBe("call_a");
    expect(msgs[2].content).toBe("BJ: 25°C");
    expect(msgs[3].role).toBe("tool");
    expect(msgs[3].tool_call_id).toBe("call_b");
    expect(msgs[3].content).toBe("SH: 22°C");
  });
});

describe("tool calling – stream comprehensive", () => {
  const adapter = createOpenAIAdapter();

  it("stream with no tool calls yields empty toolCalls array", async () => {
    const sseChunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
      "data: [DONE]",
    ].join("\n\n");
    const stream = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode(sseChunks));
        ctrl.close();
      },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const client = createLLMClient({
      registry: createRegistry([adapter]),
      resolveApiKey: () => "k",
      fetch: fetchMock as typeof fetch,
    });
    const { textStream, toolCalls } = await client.streamText({
      model: "openai/gpt-4o",
      prompt: "hi",
    });
    for await (const _ of textStream) {
      /* drain */
    }
    expect(await toolCalls).toEqual([]);
  });

  it("stream with multiple parallel tool calls aggregates correctly", async () => {
    const sseChunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "f1", arguments: "" } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "f2", arguments: "" } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a' } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"b' } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '":1}' } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '":2}' } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}`,
      "data: [DONE]",
    ].join("\n\n");
    const stream = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode(sseChunks));
        ctrl.close();
      },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const client = createLLMClient({
      registry: createRegistry([adapter]),
      resolveApiKey: () => "k",
      fetch: fetchMock as typeof fetch,
    });
    const { textStream, toolCalls, finishReason } = await client.streamText({
      model: "openai/gpt-4o",
      prompt: "parallel call",
      tools: [
        { name: "f1", description: "F1" },
        { name: "f2", description: "F2" },
      ],
    });
    let tcDeltas = 0;
    for await (const c of textStream) {
      if (c.type === "tool-call-delta") tcDeltas++;
    }
    expect(tcDeltas).toBe(6);
    const calls = await toolCalls;
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ id: "call_a", name: "f1", arguments: '{"a":1}' });
    expect(calls[1]).toEqual({ id: "call_b", name: "f2", arguments: '{"b":2}' });
    expect(await finishReason).toBe("tool_calls");
  });

  it("stream interleaves text, reasoning, and tool calls", async () => {
    const sseChunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking..." } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "I will " } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "call " } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "search", arguments: '{"q":' } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"test"}' } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}`,
      "data: [DONE]",
    ].join("\n\n");
    const stream = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode(sseChunks));
        ctrl.close();
      },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const client = createLLMClient({
      registry: createRegistry([adapter]),
      resolveApiKey: () => "k",
      fetch: fetchMock as typeof fetch,
    });
    const { textStream, text, reasoning, toolCalls } = await client.streamText({
      model: "openai/gpt-4o",
      prompt: "search test",
      tools: [{ name: "search", description: "Search" }],
    });
    const chunks: string[] = [];
    for await (const c of textStream) {
      chunks.push(c.type);
    }
    expect(chunks).toEqual([
      "reasoning-delta",
      "text-delta",
      "text-delta",
      "tool-call-delta",
      "tool-call-delta",
      "finish",
    ]);
    expect(await text).toBe("I will call ");
    expect(await reasoning).toBe("thinking...");
    expect(await toolCalls).toEqual([{ id: "call_1", name: "search", arguments: '{"q":"test"}' }]);
  });

  it("stream tool-call-delta with only argumentsDelta (no id/name on subsequent chunks)", async () => {
    const sseChunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_x", type: "function", function: { name: "calc", arguments: "" } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1" } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "+2" } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "=3" } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}`,
      "data: [DONE]",
    ].join("\n\n");
    const stream = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode(sseChunks));
        ctrl.close();
      },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const client = createLLMClient({
      registry: createRegistry([adapter]),
      resolveApiKey: () => "k",
      fetch: fetchMock as typeof fetch,
    });
    const { textStream, toolCalls } = await client.streamText({
      model: "openai/gpt-4o",
      prompt: "calc",
      tools: [{ name: "calc", description: "Calculate" }],
    });
    const deltas: unknown[] = [];
    for await (const c of textStream) {
      if (c.type === "tool-call-delta") deltas.push(c);
    }
    expect(deltas[0]).toMatchObject({ id: "call_x", name: "calc" });
    expect(deltas[1]).not.toHaveProperty("id");
    expect(deltas[1]).toMatchObject({ argumentsDelta: "1" });
    expect(await toolCalls).toEqual([{ id: "call_x", name: "calc", arguments: "1+2=3" }]);
  });
});

describe("tool calling – buildCanonicalRequest", () => {
  it("passes tools and toolChoice through to CanonicalRequest", () => {
    const r = buildCanonicalRequest({
      handle: modelRef("openai", "gpt-4o"),
      prompt: "search",
      tools: [{ name: "search", description: "Search" }],
      toolChoice: "auto",
    });
    expect(r.tools).toHaveLength(1);
    expect(r.tools![0].name).toBe("search");
    expect(r.toolChoice).toBe("auto");
  });

  it("returns undefined tools when not provided", () => {
    const r = buildCanonicalRequest({
      handle: modelRef("openai", "gpt-4o"),
      prompt: "hi",
    });
    expect(r.tools).toBeUndefined();
    expect(r.toolChoice).toBeUndefined();
  });
});

describe("tool calling – client integration", () => {
  it("generateText through client passes tools and returns toolCalls", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    { id: "c1", type: "function", function: { name: "f", arguments: "{}" } },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const client = createLLMClient({
      registry: createRegistry([createOpenAIAdapter()]),
      resolveApiKey: () => "k",
      fetch: fetchMock as typeof fetch,
    });
    const r = await client.generateText({
      model: "openai/gpt-4o",
      prompt: "call f",
      tools: [{ name: "f", description: "Do f" }],
      toolChoice: "required",
    });
    expect(r.finishReason).toBe("tool_calls");
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls![0].name).toBe("f");
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toBe("required");
  });

  it("streamText through client with tool round-trip", async () => {
    const sseChunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "calling tool" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "echo", arguments: '{"x":1}' } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}`,
      "data: [DONE]",
    ].join("\n\n");
    const stream = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode(sseChunks));
        ctrl.close();
      },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const client = createLLMClient({
      registry: createRegistry([createOpenAIAdapter()]),
      resolveApiKey: () => "k",
      fetch: fetchMock as typeof fetch,
    });
    const { textStream, text, toolCalls } = await client.streamText({
      model: "openai/gpt-4o",
      prompt: "test",
      tools: [{ name: "echo", description: "Echo" }],
    });
    for await (const _ of textStream) {
      /* drain */
    }
    expect(await text).toBe("calling tool");
    expect(await toolCalls).toEqual([{ id: "c1", name: "echo", arguments: '{"x":1}' }]);
  });
});
