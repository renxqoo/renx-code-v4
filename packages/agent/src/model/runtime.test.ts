import { describe, expect, it, vi, beforeEach } from "vitest";
import { runtime, isRecoverableError, RuntimeError } from "./runtime";

vi.mock("@renx/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@renx/provider")>();
  return { ...actual, streamText: vi.fn() };
});

import { streamText } from "@renx/provider";
const mockStreamText = vi.mocked(streamText);

function okResult() {
  return {
    textStream: (async function* () {})(),
    text: Promise.resolve("hello"),
    reasoning: Promise.resolve(""),
    toolCalls: Promise.resolve([]),
    usage: Promise.resolve(undefined),
    finishReason: Promise.resolve("stop" as const),
  };
}

const baseConfig = {
  model: "test" as any,
  systemPrompt: "",
  messages: [],
};

describe("runtime", () => {
  beforeEach(() => {
    mockStreamText.mockReset();
  });

  it("returns ok: true on success", async () => {
    mockStreamText.mockResolvedValue(okResult());
    const result = await runtime(baseConfig);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(await result.text).toBe("hello");
    }
  });

  it("returns ok: false for generic Error", async () => {
    mockStreamText.mockRejectedValue(new Error("API rate limit"));
    const result = await runtime(baseConfig);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as Error).message).toBe("API rate limit");
    }
  });

  it("lets TypeError propagate (programming error)", async () => {
    mockStreamText.mockRejectedValue(new TypeError("Cannot read properties of undefined"));
    await expect(runtime(baseConfig)).rejects.toThrow(TypeError);
  });

  it("lets SyntaxError propagate", async () => {
    mockStreamText.mockRejectedValue(new SyntaxError("unexpected token"));
    await expect(runtime(baseConfig)).rejects.toThrow(SyntaxError);
  });

  it("lets ReferenceError propagate", async () => {
    mockStreamText.mockRejectedValue(new ReferenceError("x is not defined"));
    await expect(runtime(baseConfig)).rejects.toThrow(ReferenceError);
  });

  it("catches network-related TypeError", async () => {
    mockStreamText.mockRejectedValue(new TypeError("fetch failed"));
    const result = await runtime(baseConfig);
    expect(result.ok).toBe(false);
  });

  it("catches DOMException AbortError", async () => {
    const abortErr = new DOMException("The operation was aborted", "AbortError");
    mockStreamText.mockRejectedValue(abortErr);
    const result = await runtime(baseConfig);
    expect(result.ok).toBe(false);
  });
});

describe("isRecoverableError", () => {
  it("marks Error as recoverable", () => {
    expect(isRecoverableError(new Error("fail"))).toBe(true);
  });

  it("marks RuntimeError as recoverable", () => {
    expect(isRecoverableError(new RuntimeError("test", new Error()))).toBe(true);
  });

  it("marks TypeError as non-recoverable by default", () => {
    expect(isRecoverableError(new TypeError("bad"))).toBe(false);
  });

  it("marks network TypeError as recoverable", () => {
    expect(isRecoverableError(new TypeError("fetch failed"))).toBe(true);
    expect(isRecoverableError(new TypeError("Network request failed"))).toBe(true);
  });

  it("marks SyntaxError as non-recoverable", () => {
    expect(isRecoverableError(new SyntaxError())).toBe(false);
  });

  it("marks ReferenceError as non-recoverable", () => {
    expect(isRecoverableError(new ReferenceError())).toBe(false);
  });

  it("marks RangeError as non-recoverable", () => {
    expect(isRecoverableError(new RangeError())).toBe(false);
  });

  it("marks objects with status as recoverable", () => {
    expect(isRecoverableError({ status: 429 })).toBe(true);
  });
});
