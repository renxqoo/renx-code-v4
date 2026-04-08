import { afterEach, describe, expect, it } from "vitest";
import { createEchoAdapter } from "../adapters/echo-adapter";
import { createRegistry } from "../registry";
import {
  generateText,
  streamText,
  generateImage,
  textToSpeech,
  transcribe,
  generateVideo,
  getVideoJob,
  downloadVideo,
  getDefaultClient,
  resetDefaultClient,
} from "../functional";

// ---------------------------------------------------------------------------
// Every test must reset the module-level singleton so they don't leak state.
// ---------------------------------------------------------------------------
afterEach(() => {
  resetDefaultClient();
});

/** Common echo-based client options so the default client uses echo adapter. */
const echoOpts = {
  registry: createRegistry([createEchoAdapter()]),
  useEnv: false,
  apiKeys: { echo: "test-key" },
};

// ── Lazy singleton behaviour ────────────────────────────────────────────────

describe("functional API – lazy singleton", () => {
  it("creates a default client on first call", () => {
    const c = getDefaultClient(echoOpts);
    expect(c).toBeDefined();
    expect(typeof c.generateText).toBe("function");
  });

  it("returns the same instance on subsequent calls", () => {
    const a = getDefaultClient(echoOpts);
    const b = getDefaultClient();
    expect(a).toBe(b);
  });

  it("ignores new options after first initialisation", () => {
    const a = getDefaultClient(echoOpts);
    // Pass no options — should still return same instance
    const b = getDefaultClient();
    expect(a).toBe(b);
  });

  it("resetDefaultClient forces re-creation", () => {
    const a = getDefaultClient(echoOpts);
    resetDefaultClient();
    const b = getDefaultClient(echoOpts);
    expect(a).not.toBe(b);
  });
});

// ── generateText ────────────────────────────────────────────────────────────

describe("functional generateText", () => {
  it("works with echo adapter and string prompt", async () => {
    const r = await generateText({ model: "echo/test", prompt: "hello" }, echoOpts);
    expect(r.text).toBe("echo:hello");
  });

  it("works with multimodal prompt", async () => {
    const r = await generateText(
      {
        model: "echo/m",
        prompt: [
          { type: "text", text: "look " },
          { type: "image_url", url: "https://x.com/a.png" },
        ],
      },
      echoOpts,
    );
    expect(r.text).toContain("echo:look");
    expect(r.text).toContain("[image:url:");
  });

  it("works with messages array", async () => {
    const r = await generateText(
      {
        model: "echo/m",
        messages: [
          { role: "system", content: [{ type: "text", text: "sys" }] },
          { role: "user", content: [{ type: "text", text: "hi" }] },
        ],
      },
      echoOpts,
    );
    expect(r.text).toBe("echo:sys\nhi");
  });

  it("works with systemPrompt shortcut", async () => {
    const r = await generateText(
      { model: "echo/m", prompt: "q", systemPrompt: "be concise" },
      echoOpts,
    );
    expect(r.text).toBe("echo:be concise\nq");
  });

  it("returns finishReason and usage from echo", async () => {
    const r = await generateText({ model: "echo/m", prompt: "x" }, echoOpts);
    expect(r.finishReason).toBe("stop");
    expect(r.usage?.totalTokens).toBe(2);
  });

  it("strips raw by default", async () => {
    const r = await generateText({ model: "echo/m", prompt: "x" }, echoOpts);
    expect(r.raw).toBeUndefined();
  });
});

// ── streamText ──────────────────────────────────────────────────────────────

describe("functional streamText", () => {
  it("streams text and resolves promises", async () => {
    const { textStream, text, finishReason, usage } = await streamText(
      { model: "echo/test", prompt: "abc" },
      echoOpts,
    );
    let deltas = "";
    for await (const c of textStream) {
      if (c.type === "text-delta") deltas += c.textDelta;
    }
    expect(deltas).toBe("echo:abc");
    await expect(text).resolves.toBe("echo:abc");
    await expect(finishReason).resolves.toBe("stop");
    await expect(usage).resolves.toEqual({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  });
});

// ── generateImage ───────────────────────────────────────────────────────────

describe("functional generateImage", () => {
  it("returns echo image URL", async () => {
    const r = await generateImage({ model: "echo/m", prompt: "a cat" }, echoOpts);
    expect(r.images.length).toBe(1);
    expect(r.images[0]?.url).toMatch(/^echo:\/\/image/);
  });
});

// ── textToSpeech ────────────────────────────────────────────────────────────

describe("functional textToSpeech", () => {
  it("returns echo audio bytes", async () => {
    const r = await textToSpeech({ model: "echo/m", text: "hello world" }, echoOpts);
    expect(r.audio.length).toBeGreaterThan(0);
    expect(r.contentType).toBeDefined();
  });
});

// ── transcribe ──────────────────────────────────────────────────────────────

describe("functional transcribe", () => {
  it("returns echo transcription", async () => {
    const r = await transcribe(
      { model: "echo/m", audio: new TextEncoder().encode("test audio") },
      echoOpts,
    );
    expect(r.text).toContain("transcribed:");
    expect(r.language).toBe("en");
  });
});

// ── generateVideo / getVideoJob / downloadVideo ─────────────────────────────

describe("functional video pipeline", () => {
  it("starts job, polls status, downloads", async () => {
    // 1. Start job
    const vid = await generateVideo({ model: "echo/m", prompt: "sunset" }, echoOpts);
    expect(vid.videoId).toContain("echo_vid_");
    expect(vid.status).toBe("queued");

    // 2. Poll status
    const job = await getVideoJob({ model: "echo/m", videoId: vid.videoId }, echoOpts);
    expect(job.status).toBe("completed");
    expect(job.fileId).toBeDefined();

    // 3. Download by videoId
    const bin = await downloadVideo({ model: "echo/m", videoId: vid.videoId }, echoOpts);
    expect(bin.data.length).toBeGreaterThan(0);

    // 4. Download by fileId
    const bin2 = await downloadVideo({ model: "echo/m", fileId: job.fileId }, echoOpts);
    expect(bin2.data.length).toBeGreaterThan(0);
  });
});

// ── Error propagation ───────────────────────────────────────────────────────

describe("functional API error handling", () => {
  it("throws UNAUTHORIZED when no API key", async () => {
    // Use a registry with echo but no apiKeys, and env disabled
    await expect(
      generateText(
        { model: "echo/test", prompt: "hi" },
        { registry: createRegistry([createEchoAdapter()]), useEnv: false },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("throws NOT_IMPLEMENTED for unsupported capability", async () => {
    // Anthropic doesn't support generateImage
    const { createAnthropicAdapter } = await import("../adapters/anthropic-adapter");
    await expect(
      generateImage(
        { model: "anthropic/claude-3", prompt: "x" },
        {
          registry: createRegistry([createAnthropicAdapter()]),
          useEnv: false,
          apiKeys: { anthropic: "k" },
        },
      ),
    ).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
  });
});

// ── Multiple sequential calls share singleton ──────────────────────────────

describe("functional API – multiple calls share client", () => {
  it("shares default client across sequential generateText calls", async () => {
    const r1 = await generateText({ model: "echo/a", prompt: "first" }, echoOpts);
    const r2 = await generateText({ model: "echo/b", prompt: "second" }, echoOpts);
    expect(r1.text).toBe("echo:first");
    expect(r2.text).toBe("echo:second");

    // Verify singleton was created only once
    const c1 = getDefaultClient();
    const c2 = getDefaultClient();
    expect(c1).toBe(c2);
  });
});
