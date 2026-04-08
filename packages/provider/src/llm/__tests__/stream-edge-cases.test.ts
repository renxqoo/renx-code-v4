import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAIAdapter } from "../adapters/openai-adapter";
import { createAnthropicAdapter } from "../adapters/anthropic-adapter";
import { createLLMClient } from "../client";
import { createEchoAdapter } from "../adapters/echo-adapter";
import { createRegistry } from "../registry";
import { defaultRetryPolicy, executeWithRetry } from "../retry";
import { LLMError } from "../errors";
import type { AdapterInvokeContext } from "../adapter";
import type { CanonicalRequest } from "../types";

const minimalReq: CanonicalRequest = {
  modelId: "gpt-4o-mini",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  params: {},
};

/** Like real `fetch`: stays pending until `signal` aborts, then rejects with `signal.reason` (or AbortError). */
function fetchPendingUntilSignalAborts(): typeof fetch {
  const impl = (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("mock fetch requires AbortSignal"));
        return;
      }
      const onAbort = (): void => {
        const r = signal.reason;
        if (LLMError.isInstance(r)) reject(r);
        else if (r !== undefined) reject(r);
        else reject(new DOMException("The operation was aborted.", "AbortError"));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  return impl as typeof fetch;
}

function openaiCtx(fetchImpl: typeof fetch): AdapterInvokeContext {
  return {
    fetch: fetchImpl,
    apiKey: "k",
    vendorId: "openai",
  };
}

describe("stream timeout semantics (adapter)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears wall-clock timeout after response headers: slow body still completes", async () => {
    const adapter = createOpenAIAdapter();
    const sseLine = `data: ${JSON.stringify({
      choices: [{ delta: { content: "late" } }],
    })}\n\n`;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(sseLine));
          controller.close();
        }, 80);
      },
    });
    const fetchMock = vi.fn(async () => {
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const iter = await adapter.streamText(minimalReq, {
      ...openaiCtx(fetchMock as typeof fetch),
      timeoutMs: 20,
    });

    await new Promise((r) => setTimeout(r, 120));

    const deltas: string[] = [];
    for await (const c of iter) {
      if (c.type === "text-delta") deltas.push(c.textDelta);
    }
    expect(deltas.join("")).toBe("late");
  });

  it("times out when fetch does not resolve before timeoutMs (stream open)", async () => {
    const adapter = createOpenAIAdapter();
    const fetchMock = vi.fn(fetchPendingUntilSignalAborts());

    const p = adapter.streamText(minimalReq, {
      ...openaiCtx(fetchMock as typeof fetch),
      timeoutMs: 40,
    });

    await expect(p).rejects.toMatchObject({ code: "TIMEOUT" });
  }, 10_000);

  it("times out when generateText fetch does not resolve", async () => {
    const adapter = createOpenAIAdapter();
    const fetchMock = vi.fn(fetchPendingUntilSignalAborts());

    const p = adapter.generateText(minimalReq, {
      ...openaiCtx(fetchMock as typeof fetch),
      timeoutMs: 40,
    });

    await expect(p).rejects.toMatchObject({ code: "TIMEOUT" });
  }, 10_000);
});

describe("OpenAI stream edge cases", () => {
  it("SSE only [DONE] yields finish with empty text", async () => {
    const adapter = createOpenAIAdapter();
    const raw = "data: [DONE]\n\n";
    const fetchMock = vi.fn(async () => {
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(raw));
            c.close();
          },
        }),
        { status: 200 },
      );
    });
    const iter = await adapter.streamText(minimalReq, {
      ...openaiCtx(fetchMock as typeof fetch),
    });
    const parts: { type: string; textDelta?: string }[] = [];
    for await (const c of iter) {
      parts.push(
        c.type === "text-delta" ? { type: c.type, textDelta: c.textDelta } : { type: c.type },
      );
    }
    expect(parts.filter((p) => p.type === "text-delta")).toHaveLength(0);
    expect(parts.some((p) => p.type === "finish")).toBe(true);
  });

  it("generateText tolerates missing message content", async () => {
    const adapter = createOpenAIAdapter();
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const out = await adapter.generateText(minimalReq, {
      ...openaiCtx(fetchMock as typeof fetch),
    });
    expect(out.text).toBe("");
    expect(out.finishReason).toBe("stop");
  });

  it("stream open retries then succeeds", async () => {
    const adapter = createOpenAIAdapter();
    let n = 0;
    const sse = `data: ${JSON.stringify({
      choices: [{ delta: { content: "ok" } }],
    })}\n\ndata: [DONE]\n\n`;
    const fetchMock = vi.fn(async () => {
      n++;
      if (n < 3) {
        return new Response(JSON.stringify({ error: { message: "slow" } }), {
          status: 429,
        });
      }
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(sse));
            c.close();
          },
        }),
        { status: 200 },
      );
    });

    const iter = await executeWithRetry(
      () => adapter.streamText(minimalReq, openaiCtx(fetchMock as typeof fetch)),
      {
        policy: {
          ...defaultRetryPolicy,
          maxAttempts: 5,
          initialDelayMs: 0,
          jitterRatio: 0,
        },
        isRetryable: (e) => LLMError.isInstance(e) && e.retryable,
      },
    );

    let text = "";
    for await (const c of iter) {
      if (c.type === "text-delta") text += c.textDelta;
    }
    expect(text).toBe("ok");
    expect(n).toBe(3);
  });
});

describe("Anthropic edge cases", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("generateText with empty content array yields empty text", async () => {
    const adapter = createAnthropicAdapter();
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          content: [],
          stop_reason: "end_turn",
        }),
        { status: 200 },
      );
    });
    const out = await adapter.generateText(minimalReq, {
      fetch: fetchMock as typeof fetch,
      apiKey: "k",
      vendorId: "anthropic",
    });
    expect(out.text).toBe("");
  });

  it("stream connect timeout same as OpenAI", async () => {
    const adapter = createAnthropicAdapter();
    const fetchMock = vi.fn(fetchPendingUntilSignalAborts());
    const p = adapter.streamText(minimalReq, {
      fetch: fetchMock as typeof fetch,
      apiKey: "k",
      vendorId: "anthropic",
      timeoutMs: 40,
    });
    await expect(p).rejects.toMatchObject({ code: "TIMEOUT" });
  }, 10_000);
});

describe("SSE / stream failure propagation", () => {
  it("propagates when ReadableStream read rejects", async () => {
    const adapter = createOpenAIAdapter();
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("reader failed");
      },
    });
    const fetchMock = vi.fn(async () => {
      return new Response(body, { status: 200 });
    });
    const iter = await adapter.streamText(minimalReq, {
      ...openaiCtx(fetchMock as typeof fetch),
    });
    await expect(
      (async () => {
        for await (const _ of iter) {
          /* drain */
        }
      })(),
    ).rejects.toThrow("reader failed");
  });
});

describe("client stream + user abort (current semantics)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("abort before streamText connect rejects with ABORTED", async () => {
    const ac = new AbortController();
    const fetchMock = vi.fn(fetchPendingUntilSignalAborts());
    const client = createLLMClient({
      registry: createRegistry([createOpenAIAdapter()]),
      resolveApiKey: () => "k",
      fetch: fetchMock as typeof fetch,
      defaultTimeoutMs: 60_000,
    });
    const p = client.streamText({
      model: "openai/gpt-4o-mini",
      prompt: "x",
      abortSignal: ac.signal,
    });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: "ABORTED" });
  }, 10_000);

  it("after connect, user AbortSignal does not cancel echo stream body (documented gap)", async () => {
    const ac = new AbortController();
    const client = createLLMClient({
      registry: createRegistry([createEchoAdapter()]),
      resolveApiKey: () => "k",
    });
    const { textStream } = await client.streamText({
      model: "echo/m",
      prompt: "body",
      abortSignal: ac.signal,
    });
    const chunks: string[] = [];
    for await (const c of textStream) {
      if (c.type === "text-delta") {
        chunks.push(c.textDelta);
        ac.abort();
      }
    }
    expect(chunks.join("")).toContain("echo:body");
  });
});
