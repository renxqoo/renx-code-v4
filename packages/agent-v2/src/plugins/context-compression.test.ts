import { describe, it, expect, afterAll } from "vitest";
import { pipe } from "../plugin.js";
import {
  withContextCompression,
  getContextMessages,
  clearContextWindow,
} from "./context-compression.js";
import { userMessage } from "../message.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SESSION = "vitest-context-smoke";
const ctxFile = join(homedir(), ".renx-code", "context", `${SESSION}.json`);

describe("context compression persistence", () => {
  afterAll(() => {
    clearContextWindow();
  });

  it("creates context dir, persists to file, clears on demand", async () => {
    clearContextWindow();

    const app = pipe(
      withContextCompression({ maxTokens: 200, keepLastN: 2, sessionId: SESSION }),
      async function* (_input: any) {
        yield { type: "run:finished" as const, outcome: { runId: "t1", messages: [], totalSteps: 1, finishReason: "stop" } };
      },
    );

    const g1 = app({ model: "test", messages: [userMessage("hello world")], systemPrompt: "" });
    for await (const _ of g1) {}

    expect(existsSync(ctxFile)).toBe(true);
    console.log("  OK: context file created");

    expect(getContextMessages().length).toBe(1);
    console.log("  OK: 1 message in context");

    clearContextWindow();
    expect(existsSync(ctxFile)).toBe(false);
    console.log("  OK: file deleted after clear");
  });

  it("fails gracefully when no LLM client available for compression", async () => {
    clearContextWindow();
    const app = pipe(
      withContextCompression({ maxTokens: 100, keepLastN: 1, sessionId: SESSION }),
      async function* (_input: any) {
        yield { type: "run:finished" as const, outcome: { runId: "t2", messages: [], totalSteps: 1, finishReason: "stop" } };
      },
    );

    const g = app({ model: "test", messages: [userMessage("x".repeat(5000))], systemPrompt: "" });
    for await (const _ of g) {}
    expect(getContextMessages().length).toBeGreaterThan(0);
    console.log("  OK: compression fallback, messages preserved");
  });
});
