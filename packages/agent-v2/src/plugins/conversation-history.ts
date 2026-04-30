/**
 * withConversationHistory Plugin — audit-only observer.
 *
 * Records every agent event to a JSONL session file for audit / replay.
 * Does NOT inject history into the LLM context — that's the job of
 * withContextCompression (sliding context window).
 *
 * Storage layout (append-only JSONL):
 * ```
 * $HOME/.renx-code/sessions/
 *   2026/
 *     04/
 *       29/
 *         session-2026-04-29T10-30-00-{uuid}.jsonl
 * ```
 *
 * Record types per line:
 * - session_started  — session metadata (model, systemPrompt, tools)
 * - turn_started     — user input messages
 * - event            — raw AgentEvent (llm:delta, llm:tool-call, tool:result, etc.)
 * - turn_completed   — turn summary (tokenUsage, finishReason, steps, duration)
 */
import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "../plugin.js";
import type { AgentInput, AgentGenerator } from "../types.js";
import type { Message } from "../message.js";
import type { TokenUsage } from "../state.js";
import type { AgentEvent } from "../events.js";
import { generateId } from "../utils/id.js";
import { renxSessionsDir } from "../utils/paths.js";

// ── Options ───────────────────────────────────────────────────────────

export interface ConversationHistoryOptions {
  /**
   * Root directory for session files.
   * Individual sessions are stored as `{root}/{year}/{month}/{day}/session-{ts}-{uuid}.jsonl`.
   * Defaults to `$HOME/.renx-code/sessions`.
   */
  sessionsDir?: string;
  /**
   * Continue a specific session by its UUID. When provided, the plugin
   * locates the existing session file and appends new turns to it.
   * If omitted, a new session ID is generated.
   */
  sessionId?: string;
}

// ── JSONL record types ────────────────────────────────────────────────

interface SessionStartedRecord {
  t: "session_started";
  ts: string;
  sid: string;
  model?: string;
  systemPrompt?: string;
  tools?: string[];
}

interface TurnStartedRecord {
  t: "turn_started";
  ts: string;
  turn: number;
  messages: Message[];
}

/** Raw agent event written inline with context. */
interface AgentEventRecord {
  t: "event";
  ts: string;
  turn: number;
  ev: AgentEvent;
}

interface TurnCompletedRecord {
  t: "turn_completed";
  ts: string;
  turn: number;
  tokenUsage?: TokenUsage;
  finishReason?: string;
  totalSteps?: number;
  durationMs: number;
}

type SessionRecord =
  | SessionStartedRecord
  | TurnStartedRecord
  | AgentEventRecord
  | TurnCompletedRecord;

// ── Reconstructed turn (public type) ──────────────────────────────────

export interface ConversationTurn {
  timestamp: string;
  runId: string;
  model: string;
  messages: Message[];
  tokenUsage?: TokenUsage;
  finishReason?: string;
  totalSteps?: number;
  durationMs?: number;
}

// ── Module-level state ─────────────────────────────────────────────────

interface HistoryState {
  curTurn: number;
  sessionId: string;
}

let _historyState: HistoryState | null = null;

/**
 * Returns the UUID of the current session, or "" if no session is active.
 * Useful for displaying to users and passing to withContextCompression.
 */
export function getSessionId(): string {
  return _historyState?.sessionId ?? "";
}

// ── Plugin ────────────────────────────────────────────────────────────

/**
 * Audit-only observer Plugin. Records every agent event to a JSONL
 * session file. Does NOT modify the message pipeline — input messages
 * pass through unchanged.
 *
 * By default starts a fresh session. Pass `sessionId` in options
 * to continue appending to an existing session file.
 */
export function withConversationHistory(opts?: ConversationHistoryOptions): Plugin {
  const root = renxSessionsDir(opts?.sessionsDir);
  const sessionId = opts?.sessionId || generateId();

  // Initialize / resume state (turn counter, session ID)
  const state: HistoryState = { curTurn: 0, sessionId };
  _historyState = state;

  // Session file: lazy-init on first turn
  let sessionFile: string | null = null;

  return (inner) =>
    async function* (input: AgentInput): AgentGenerator {
      const startTime = Date.now();
      const turnIndex = state.curTurn++;
      let tokenUsage: TokenUsage | undefined;
      let finishReason: string | undefined;
      let totalSteps: number | undefined;

      // ── Lazy-init session file ──────────────────────────────
      if (!sessionFile) {
        const now = new Date();
        const dir = join(
          root,
          String(now.getFullYear()),
          String(now.getMonth() + 1).padStart(2, "0"),
          String(now.getDate()).padStart(2, "0"),
        );
        mkdirSync(dir, { recursive: true });
        sessionFile = join(dir, `session-${toFileTimestamp(now)}-${sessionId}.jsonl`);
        await appendRecord(sessionFile, {
          t: "session_started",
          ts: now.toISOString(),
          sid: sessionId,
          model: input.model,
          systemPrompt: input.systemPrompt,
          tools: input.tools?.map((t) => (typeof t === "string" ? t : t.name)),
        });
      }

      // ── turn_started ────────────────────────────────────────
      await appendRecord(sessionFile, {
        t: "turn_started",
        ts: new Date().toISOString(),
        turn: turnIndex,
        messages: input.messages ?? [],
      });

      // ── Event observation — write every event, pass through ──
      for await (const event of inner(input)) {
        // Write raw event to JSONL (crash-safe: one line per event)
        await appendRecord(sessionFile, {
          t: "event",
          ts: new Date().toISOString(),
          turn: turnIndex,
          ev: event,
        });

        // Capture run metadata for turn_completed
        switch (event.type) {
          case "llm:done":
            tokenUsage = event.usage;
            if (!finishReason) finishReason = event.finishReason;
            break;
          case "run:finished":
            finishReason = event.outcome?.finishReason;
            totalSteps = event.outcome?.totalSteps;
            break;
        }
        yield event;
      }

      // ── turn_completed ──────────────────────────────────────
      await appendRecord(sessionFile, {
        t: "turn_completed",
        ts: new Date().toISOString(),
        turn: turnIndex,
        tokenUsage,
        finishReason,
        totalSteps,
        durationMs: Date.now() - startTime,
      });
    };
}

// ── Helpers ───────────────────────────────────────────────────────────

function toFileTimestamp(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${y}-${mo}-${d}T${h}-${mi}-${s}`;
}

async function appendRecord(filePath: string, record: SessionRecord): Promise<void> {
  await appendFile(filePath, JSON.stringify(record) + "\n", "utf-8");
}
