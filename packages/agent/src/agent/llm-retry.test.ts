import { describe, expect, it } from "vitest";
import { computeRetryDelayMs } from "./llm-retry";

describe("computeRetryDelayMs", () => {
  it("returns 0 when retryDelayMs omitted or 0", () => {
    expect(computeRetryDelayMs(undefined, 0)).toBe(0);
    expect(computeRetryDelayMs({ maxRetries: 1, retryDelayMs: 0 }, 0)).toBe(0);
  });

  it("applies fixed delay when multiplier is 1", () => {
    expect(computeRetryDelayMs({ maxRetries: 2, retryDelayMs: 200 }, 0)).toBe(200);
    expect(computeRetryDelayMs({ maxRetries: 2, retryDelayMs: 200 }, 1)).toBe(200);
  });

  it("applies exponential backoff", () => {
    expect(
      computeRetryDelayMs({ maxRetries: 3, retryDelayMs: 100, retryBackoffMultiplier: 2 }, 0),
    ).toBe(100);
    expect(
      computeRetryDelayMs({ maxRetries: 3, retryDelayMs: 100, retryBackoffMultiplier: 2 }, 1),
    ).toBe(200);
    expect(
      computeRetryDelayMs({ maxRetries: 3, retryDelayMs: 100, retryBackoffMultiplier: 2 }, 2),
    ).toBe(400);
  });

  it("caps by retryMaxDelayMs", () => {
    expect(
      computeRetryDelayMs(
        { maxRetries: 3, retryDelayMs: 100, retryBackoffMultiplier: 10, retryMaxDelayMs: 250 },
        2,
    ),
    ).toBe(250);
  });
});
