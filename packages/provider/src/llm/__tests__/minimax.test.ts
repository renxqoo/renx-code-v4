import { describe, expect, it, vi } from "vitest";
import { hexToBytes } from "../internal/util";
import { createStatusMapper } from "../internal/video-status";
import { createMinimaxAdapter } from "../minimax/adapter";

function minimaxOk(body: Record<string, unknown>, status = 200): Response {
  return new Response(
    JSON.stringify({ base_resp: { status_code: 0, status_msg: "success" }, ...body }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function minimaxErr(statusCode: number, statusMsg = "error", httpStatus = 200): Response {
  return new Response(
    JSON.stringify({ base_resp: { status_code: statusCode, status_msg: statusMsg } }),
    { status: httpStatus, headers: { "content-type": "application/json" } },
  );
}

const ctx = (fetchMock: ReturnType<typeof vi.fn>) => ({
  fetch: fetchMock as typeof fetch,
  apiKey: "k",
  vendorId: "minimax",
});

describe("minimax adapter – generateImage", () => {
  it("parses image_urls", async () => {
    const fetchMock = vi.fn(async () =>
      minimaxOk({ data: { image_urls: ["https://cdn.example.com/a.png"] } }),
    );
    const a = createMinimaxAdapter();
    const r = await a.generateImage!({ modelId: "image-01", prompt: "a cat" }, ctx(fetchMock));
    expect(r.images[0]?.url).toBe("https://cdn.example.com/a.png");
    expect(r.raw).toBeDefined();
  });

  it("parses image_base64 when responseFormat is b64_json", async () => {
    const fetchMock = vi.fn(async () => minimaxOk({ data: { image_base64: ["<base64data>"] } }));
    const a = createMinimaxAdapter();
    const r = await a.generateImage!(
      { modelId: "image-01", prompt: "a cat", responseFormat: "b64_json" },
      ctx(fetchMock),
    );
    expect(r.images[0]?.b64Json).toBe("<base64data>");
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body.response_format).toBe("base64");
  });

  it("maps aspect_ratio from size", async () => {
    const fetchMock = vi.fn(async () =>
      minimaxOk({ data: { image_urls: ["https://x.com/1.png"] } }),
    );
    const a = createMinimaxAdapter();
    await a.generateImage!({ modelId: "image-01", prompt: "cat", size: "1:1" }, ctx(fetchMock));
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body.aspect_ratio).toBe("1:1");
  });
});

describe("minimax adapter – textToSpeech", () => {
  it("returns audio bytes from hex payload", async () => {
    const hexAudio = "48656c6c6f"; // "Hello"
    const fetchMock = vi.fn(async () =>
      minimaxOk({ data: { audio: hexAudio }, extra_info: { audio_format: "mp3" } }),
    );
    const a = createMinimaxAdapter();
    const r = await a.textToSpeech!({ modelId: "speech-2.8-hd", text: "hi" }, ctx(fetchMock));
    expect(r.audio).toEqual(new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]));
    expect(r.contentType).toBe("audio/mp3");
  });

  it("throws INVALID_RESPONSE when audio missing", async () => {
    const fetchMock = vi.fn(async () => minimaxOk({ data: {} }));
    const a = createMinimaxAdapter();
    await expect(
      a.textToSpeech!({ modelId: "m", text: "hi" }, ctx(fetchMock)),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("uses default voice when none provided", async () => {
    const fetchMock = vi.fn(async () => minimaxOk({ data: { audio: "00ff" } }));
    const a = createMinimaxAdapter();
    await a.textToSpeech!({ modelId: "m", text: "hi" }, ctx(fetchMock));
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body.voice_setting.voice_id).toBe("male-qn-qingse");
  });
});

describe("minimax adapter – video pipeline", () => {
  it("generateVideo returns queued task", async () => {
    const fetchMock = vi.fn(async () => minimaxOk({ task_id: "task_123" }));
    const a = createMinimaxAdapter();
    const r = await a.generateVideo!(
      { modelId: "MiniMax-Hailuo-2.3", prompt: "sunset" },
      ctx(fetchMock),
    );
    expect(r.videoId).toBe("task_123");
    expect(r.status).toBe("queued");
  });

  it("generateVideo maps seconds → duration, size → resolution", async () => {
    const fetchMock = vi.fn(async () => minimaxOk({ task_id: "t" }));
    const a = createMinimaxAdapter();
    await a.generateVideo!({ modelId: "m", prompt: "x", seconds: 5, size: "768P" }, ctx(fetchMock));
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body.duration).toBe(5);
    expect(body.resolution).toBe("768P");
  });

  it("getVideoJob maps MiniMax statuses", async () => {
    const fetchMock = vi.fn(async () => minimaxOk({ task_id: "t", status: "Processing" }));
    const a = createMinimaxAdapter();
    const r = await a.getVideoJob!({ videoId: "t" }, { ...ctx(fetchMock), method: "GET" as const });
    expect(r.status).toBe("in_progress");
  });

  it("getVideoJob returns fileId on completed", async () => {
    const fetchMock = vi.fn(async () =>
      minimaxOk({ task_id: "t", status: "Success", file_id: "f_001" }),
    );
    const a = createMinimaxAdapter();
    const r = await a.getVideoJob!({ videoId: "t" }, { ...ctx(fetchMock), method: "GET" as const });
    expect(r.status).toBe("completed");
    expect(r.fileId).toBe("f_001");
  });

  it("downloadVideo requires fileId", async () => {
    const a = createMinimaxAdapter();
    await expect(a.downloadVideo!({ videoId: "t" }, ctx(vi.fn()))).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });
});

describe("minimax adapter – base_resp error mapping", () => {
  it("1002 → RATE_LIMIT (retryable)", async () => {
    const fetchMock = vi.fn(async () => minimaxErr(1002, "rate limited"));
    const a = createMinimaxAdapter();
    await expect(
      a.generateImage!({ modelId: "m", prompt: "x" }, ctx(fetchMock)),
    ).rejects.toMatchObject({ code: "RATE_LIMIT", retryable: true });
  });

  it("1004 → UNAUTHORIZED", async () => {
    const fetchMock = vi.fn(async () => minimaxErr(1004, "bad key"));
    const a = createMinimaxAdapter();
    await expect(
      a.generateImage!({ modelId: "m", prompt: "x" }, ctx(fetchMock)),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("1008 → QUOTA_EXCEEDED", async () => {
    const fetchMock = vi.fn(async () => minimaxErr(1008, "quota"));
    const a = createMinimaxAdapter();
    await expect(
      a.generateImage!({ modelId: "m", prompt: "x" }, ctx(fetchMock)),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });

  it("1026 → CONTENT_FILTER", async () => {
    const fetchMock = vi.fn(async () => minimaxErr(1026, "filtered"));
    const a = createMinimaxAdapter();
    await expect(
      a.generateImage!({ modelId: "m", prompt: "x" }, ctx(fetchMock)),
    ).rejects.toMatchObject({ code: "CONTENT_FILTER" });
  });

  it("unknown code → INVALID_REQUEST", async () => {
    const fetchMock = vi.fn(async () => minimaxErr(9999, "unknown"));
    const a = createMinimaxAdapter();
    await expect(
      a.generateImage!({ modelId: "m", prompt: "x" }, ctx(fetchMock)),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});

// ── Shared utility tests ────────────────────────────────────────────────────

describe("hexToBytes", () => {
  it("decodes hex to bytes", () => {
    expect(hexToBytes("48656c6c6f")).toEqual(new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]));
  });

  it("handles 0x prefix", () => {
    expect(hexToBytes("0xAB")).toEqual(new Uint8Array([0xab]));
  });

  it("handles leading/trailing whitespace", () => {
    expect(hexToBytes("  ff  ")).toEqual(new Uint8Array([0xff]));
  });

  it("throws on odd-length input", () => {
    expect(() => hexToBytes("abc")).toThrow(/odd length/);
  });
});

describe("minimax adapter – providerOptions forwarding", () => {
  it("passes flat providerOptions into request body via OpenAI adapter", async () => {
    // Adapter reads providerOptions directly (no namespace key).
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl-1",
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const a = createMinimaxAdapter();
    await a.generateText!(
      {
        modelId: "MiniMax-M2.7",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        params: {},
        providerOptions: { reasoning_split: true, custom_field: "val" },
      },
      ctx(fetchMock),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body.reasoning_split).toBe(true);
    expect(body.custom_field).toBe("val");
  });
});

describe("createStatusMapper", () => {
  it("maps known values", () => {
    const map = createStatusMapper({ A: "queued", B: "completed" });
    expect(map("A")).toBe("queued");
    expect(map("B")).toBe("completed");
  });

  it("returns fallback for unknown", () => {
    const map = createStatusMapper({ A: "queued" });
    expect(map("unknown")).toBe("other");
  });

  it("uses custom fallback", () => {
    const map = createStatusMapper({}, "failed" as const);
    expect(map("anything")).toBe("failed");
  });
});
