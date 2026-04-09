import { afterEach, describe, expect, it, vi } from "vitest";
import { withOptionalTimeout } from "../abort";
import { buildCanonicalRequest } from "../build-canonical-request";
import { createEnvApiKeyResolver, createStaticApiKeyResolver } from "../credentials";
import { LLMError, RetryableError, isRetryableLlmError, type LLMErrorCode } from "../errors";
import { readSseEvents } from "../internal/sse";
import { readJsonOrText } from "../internal/util";
import { modelRef, parseModelRefString } from "../model-ref";
import { toPublicMessage } from "../public-message";
import { createRegistryForVendors } from "../presets";
import { LLMRegistry } from "../registry";
import { createEchoAdapter } from "../adapters/echo-adapter";
import { defaultRetryPolicy, executeWithRetry, mergeRetryPolicy } from "../retry";
import { bytes } from "./test-helpers";

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
      'data: {"a":1}\n' +
      "\n" +
      "data: partial\n" +
      "data: line\n" +
      "\n";
    const out: { event?: string; data: string }[] = [];
    for await (const e of readSseEvents(bytes(raw))) out.push(e);
    expect(out).toEqual([{ event: "msg", data: '{"a":1}' }, { data: "partial\nline" }]);
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
    expect(toPublicMessage("NOT_LISTED" as LLMErrorCode)).toBe(toPublicMessage("UNKNOWN"));
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
    expect(
      LLMError.isInstance(new LLMError({ code: "UNKNOWN", message: "m", retryable: false })),
    ).toBe(true);
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
    expect(r.messages).toEqual([{ role: "user", content: [{ type: "text", text: "p" }] }]);
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
    expect(() => buildCanonicalRequest({ handle: modelRef("o", "m") })).toThrow(LLMError);
  });

  it("merges handle-only and call-only providerOptions", () => {
    const onlyHandle = buildCanonicalRequest({
      handle: modelRef("openai", "m", { providerOptions: { only: "h" } }),
      prompt: "x",
    });
    expect(onlyHandle.providerOptions).toEqual({ only: "h" });

    const onlyCall = buildCanonicalRequest({
      handle: modelRef("openai", "m"),
      prompt: "x",
      providerOptions: { only: "c" },
    });
    expect(onlyCall.providerOptions).toEqual({ only: "c" });
  });

  it("deep-merges providerOptions for same vendor key", () => {
    const r = buildCanonicalRequest({
      handle: modelRef("openai", "m", {
        providerOptions: { openai: { a: 1, nested: { x: 1 } } },
      }),
      prompt: "x",
      providerOptions: { openai: { b: 2, nested: { y: 2 } } },
    });
    expect(r.providerOptions).toEqual({
      a: 1,
      b: 2,
      nested: { y: 2 },
    });
  });

  it("extracts namespaced options for the active custom vendor", () => {
    const r = buildCanonicalRequest({
      handle: modelRef("acme", "m", {
        providerOptions: { acme: { alpha: 1 } },
      }),
      prompt: "x",
      providerOptions: { acme: { beta: 2 } },
    });
    expect(r.providerOptions).toEqual({ alpha: 1, beta: 2 });
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

describe("createRegistryForVendors", () => {
  it("registers specified vendors", () => {
    const r = createRegistryForVendors(["openai", "anthropic"]);
    expect(r.has("openai")).toBe(true);
    expect(r.has("anthropic")).toBe(true);
    expect(r.has("minimax")).toBe(false);
  });

  it("throws on unknown vendor", () => {
    expect(() => createRegistryForVendors(["bogus"])).toThrowError(
      expect.objectContaining({
        code: "MODEL_NOT_FOUND",
        vendor: "bogus",
        message: expect.stringMatching(/Unknown vendor/),
      }),
    );
  });
});
