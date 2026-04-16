import { describe, expect, it } from "vitest";
import { createStreamRecorder } from "./stream-recorder";

describe("createStreamRecorder", () => {
  it("accumulates text deltas", () => {
    const r = createStreamRecorder();
    r.onStreamChunk({ type: "text-delta", textDelta: "hel" }, { llmRound: 1, suppressOutput: false });
    r.onStreamChunk({ type: "text-delta", textDelta: "lo" }, { llmRound: 1, suppressOutput: false });
    expect(r.getTextAccumulated()).toBe("hello");
  });

  it("keeps chunks when keepChunks is true", () => {
    const r = createStreamRecorder({ keepChunks: true });
    const c = { type: "text-delta" as const, textDelta: "x" };
    r.onStreamChunk(c, { llmRound: 1, suppressOutput: false });
    expect(r.getChunks()).toHaveLength(1);
    expect(r.getChunks()[0]).toEqual(c);
  });

  it("resetText clears state", () => {
    const r = createStreamRecorder();
    r.onStreamChunk({ type: "text-delta", textDelta: "a" }, { llmRound: 1, suppressOutput: false });
    r.resetText();
    expect(r.getTextAccumulated()).toBe("");
    expect(r.getChunks()).toHaveLength(0);
  });
});
