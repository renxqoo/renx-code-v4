import { afterEach, describe, expect, it, vi } from "vitest";
import { withConversationHistory, getSessionId } from "./conversation-history.js";
import type { AgentInput, AgentGenerator } from "../types.js";
import { userMessage } from "../message.js";

// ── Mocks ────────────────────────────────────────────────────────────

const mockAppendFile = vi.fn();
const mockMkdirSync = vi.fn();
const mockHomedir = vi.fn(() => "/home/test");
const mockJoin = vi.fn((...args: string[]) => args.join("/"));
const mockRandomUUID = vi.fn(() => "test-session-id");

vi.mock("node:fs", () => ({
  mkdirSync: (...args: any[]) => mockMkdirSync(...args),
} as any));

vi.mock("node:fs/promises", () => ({
  appendFile: (...args: any[]) => mockAppendFile(...args),
} as any));

vi.mock("node:os", () => ({
  homedir: () => mockHomedir(),
} as any));

vi.mock("node:path", () => ({
  join: (...args: any[]) => mockJoin(...args),
} as any));

vi.mock("node:crypto", () => ({
  randomUUID: () => mockRandomUUID(),
} as any));

afterEach(() => {
  mockAppendFile.mockReset();
  mockMkdirSync.mockReset();
  mockRandomUUID.mockReset();
  mockRandomUUID.mockReturnValue("test-session-id");
  mockAppendFile.mockResolvedValue(undefined);
});

// ── Helpers ──────────────────────────────────────────────────────────

function makeInner(captureCalls: AgentInput[]) {
  return vi.fn(async function* (input: AgentInput): AgentGenerator {
    captureCalls.push(input);
    yield { type: "llm:delta", step: 1, delta: "resp" };
    yield { type: "llm:done", step: 1, finishReason: "stop", usage: { input: 10, output: 5 }, text: "resp" };
    yield { type: "run:finished", outcome: { runId: "r1", messages: [], text: "resp", workingMemory: {}, tokenUsage: { input: 10, output: 5 }, totalSteps: 1, finishReason: "stop" } };
  });
}

async function drain(gen: AgentGenerator): Promise<any[]> {
  const events: any[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("withConversationHistory", () => {
  // ─── 1. Input passes through unchanged ─────────────────────────
  it("passes input messages through unchanged (observer-only)", async () => {
    const calls: AgentInput[] = [];
    const plugin = withConversationHistory({ sessionsDir: "/tmp/sessions" });
    const app = plugin(makeInner(calls));

    await drain(app({ model: "gpt", systemPrompt: "be helpful", messages: [userMessage("hello")] }));
    await drain(app({ model: "gpt", systemPrompt: "be helpful", messages: [userMessage("world")] }));

    // Neither call should have had messages injected
    expect(calls[0]?.messages).toHaveLength(1);
    expect(calls[0]?.messages?.[0]).toMatchObject({ role: "user", content: "hello" });
    expect(calls[1]?.messages).toHaveLength(1);
    expect(calls[1]?.messages?.[0]).toMatchObject({ role: "user", content: "world" });
  });

  // ─── 2. Records JSONL (session_started, turn_started, events, turn_completed) ──
  it("records session_started, turn_started, all events, and turn_completed as JSONL", async () => {
    const calls: AgentInput[] = [];
    const plugin = withConversationHistory({ sessionsDir: "/tmp/sessions" });
    const app = plugin(makeInner(calls));

    await drain(app({ model: "gpt", systemPrompt: "be helpful", messages: [userMessage("q1")] }));

    const appendCalls: any[][] = mockAppendFile.mock.calls;
    const lines = appendCalls.map((c) => JSON.parse(c[1] as string));

    // session_started
    expect(lines[0].t).toBe("session_started");
    expect(lines[0].sid).toBe("test-session-id");
    expect(lines[0].model).toBe("gpt");
    expect(lines[0].systemPrompt).toBe("be helpful");

    // turn_started
    expect(lines[1].t).toBe("turn_started");
    expect(lines[1].turn).toBe(0);
    expect(lines[1].messages[0]).toMatchObject({ role: "user", content: "q1" });

    // events (between turn_started and turn_completed)
    const rawEvents = lines.slice(2, -1);
    expect(rawEvents.length).toBeGreaterThanOrEqual(3);
    expect(rawEvents.every((e: any) => e.t === "event")).toBe(true);

    // turn_completed
    const last = lines[lines.length - 1];
    expect(last.t).toBe("turn_completed");
    expect(last.turn).toBe(0);
    expect(typeof last.durationMs).toBe("number");
    expect(last.tokenUsage).toMatchObject({ input: 10, output: 5 });
  });

  // ─── 3. Multiple turns append to same session file ───────────
  it("appends multiple turns to the same session file", async () => {
    const calls: AgentInput[] = [];
    const plugin = withConversationHistory({ sessionsDir: "/tmp/sessions" });
    const app = plugin(makeInner(calls));

    await drain(app({ model: "gpt", systemPrompt: "", messages: [userMessage("t1")] }));
    await drain(app({ model: "gpt", systemPrompt: "", messages: [userMessage("t2")] }));

    const appendCalls: any[][] = mockAppendFile.mock.calls;
    const turnStarted = appendCalls.filter((c) => {
      try { return JSON.parse(c[1]).t === "turn_started"; } catch { return false; }
    });
    expect(turnStarted).toHaveLength(2);

    const turnCompleted = appendCalls.filter((c) => {
      try { return JSON.parse(c[1]).t === "turn_completed"; } catch { return false; }
    });
    expect(turnCompleted).toHaveLength(2);
    expect(JSON.parse(turnCompleted[1][1] as string).turn).toBe(1);
  });

  // ─── 4. getSessionId returns the session ID ──────────────────
  it("getSessionId returns the session ID after plugin creation", () => {
    // getSessionId returns "" before any plugin is created
    // After creating withConversationHistory, it should return the session ID

    // Create a new instance (overwrites _historyState)
    withConversationHistory({ sessionsDir: "/tmp/sessions" });
    expect(getSessionId()).toBe("test-session-id");
  });

  // ─── 5. Respects provided sessionId ──────────────────────────
  it("uses the provided sessionId instead of generating one", async () => {
    const calls: AgentInput[] = [];
    const plugin = withConversationHistory({ sessionsDir: "/tmp/sessions", sessionId: "my-custom-sid" });
    const app = plugin(makeInner(calls));

    await drain(app({ model: "gpt", systemPrompt: "", messages: [userMessage("q")] }));

    const appendCalls: any[][] = mockAppendFile.mock.calls;
    const firstLine = JSON.parse(appendCalls[0][1] as string);
    expect(firstLine.t).toBe("session_started");
    expect(firstLine.sid).toBe("my-custom-sid");
  });
});
