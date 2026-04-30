/**
 * withContextCompression Plugin — sliding window context management.
 *
 * Maintains a persistent context window (Message[]) with file-based storage.
 * This is SEPARATE from the full-history JSONL managed by withConversationHistory.
 *
 * Two message chains per the design:
 * ┌─ History (JSONL, ~/.renx-code/sessions/) ────────┐
 * │  append-only, 永不截断, 永不修改                     │
 * │  用途: Memory ETL, 审计, 回述                        │
 * └──────────────────────────────────────────────────┘
 *
 * ┌─ Context (JSON, ~/.renx-code/context/) ──────────┐
 * │  sliding window, 超出预算时压缩为摘要                 │
 * │  用途: 当前 LLM 调用的 context, 会话恢复               │
 * └──────────────────────────────────────────────────┘
 *
 * Persistence:
 *   Context files are stored as JSON at:
 *     $HOME/.renx-code/context/{sessionId}.json
 *
 *   On resume (same sessionId), the saved context window is loaded directly
 *   instead of re-compressing from full history.
 *
 * Exports:
 *   getContextMessages() — inspect the current context window
 *   clearContextWindow() — reset context (e.g. on /clear)
 */
import type { Plugin } from "../plugin.js";
import type { AgentInput, AgentGenerator } from "../types.js";
import type { Message, ToolCall } from "../message.js";
import { userMessage, assistantMessage } from "../message.js";
import type { LLMClient } from "../llm-client.js";
import { getDefaultLLMClient } from "../llm-client.js";
import { renxDataDir } from "../utils/paths.js";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Options ──────────────────────────────────────────

export type WithContextCompressionOptions = {
  /** Token count threshold — compression triggers when messages exceed this. */
  maxTokens: number;
  /** Model for summarization LLM calls (defaults to input.model). */
  model?: string;
  /** Characters-per-token heuristic for estimation (default 4). */
  charsPerToken?: number;
  /** Always keep at least this many most-recent messages uncompressed (default 5). */
  keepLastN?: number;
  /**
   * Session ID for context file persistence.
   * When provided, the context window is saved to / loaded from:
   *   $HOME/.renx-code/context/{sessionId}.json
   */
  sessionId?: string;
};

// ── Module-level context state ──────────────────────

interface ContextState {
  messages: Message[];
  summary: string | null;
  sessionId: string | null;
  filePath: string | null;
  dirty: boolean;
}

let _state: ContextState | null = null;

/** Return the current context window messages. */
export function getContextMessages(): Message[] {
  return _state?.messages ?? [];
}

/** Reset the context window and delete the persisted file. */
export function clearContextWindow(): void {
  if (_state?.filePath && existsSync(_state.filePath)) {
    try { unlinkSync(_state.filePath); } catch { /* best-effort */ }
  }
  _state = null;
}

// ── Persistence ─────────────────────────────────────

function contextDir(): string {
  const dir = join(renxDataDir(), "context");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function contextFilePath(sessionId: string): string {
  return join(contextDir(), `${sessionId}.json`);
}

interface SavedContext {
  sessionId: string;
  messages: Message[];
  summary: string | null;
}

function loadContext(sessionId: string): SavedContext | null {
  const path = contextFilePath(sessionId);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as SavedContext;
    if (data.sessionId === sessionId && Array.isArray(data.messages)) {
      return data;
    }
  } catch {
    // Corrupted file — ignore and start fresh
  }
  return null;
}

function saveContext(state: ContextState): void {
  if (!state.filePath) return;
  try {
    const data: SavedContext = {
      sessionId: state.sessionId!,
      messages: state.messages,
      summary: state.summary,
    };
    writeFileSync(state.filePath, JSON.stringify(data, null, 2), "utf-8");
    state.dirty = false;
  } catch {
    // Non-fatal: context will be re-computed on next resume
  }
}

// ── Helpers ──────────────────────────────────────────

function estimateMessageTokens(
  messages: Message[],
  charsPerToken: number,
): number {
  let tokens = 0;
  for (const msg of messages) {
    const contentLen = messageContentChars(msg);
    tokens += contentLen / charsPerToken + 4; // 4 overhead per message
  }
  return Math.ceil(tokens);
}

function messageContentChars(msg: Message): number {
  if (typeof msg.content === "string") return msg.content.length;
  if (Array.isArray(msg.content)) {
    let len = 0;
    for (const block of msg.content) {
      if (block.type === "text") len += block.text.length;
      else if (block.type === "tool_result") len += block.content.length;
    }
    return len;
  }
  return 0;
}

async function generateSummary(
  llmClient: LLMClient,
  model: string,
  messages: Message[],
  previousSummary: string | null,
  charsPerToken: number,
): Promise<string> {
  const tokenCount = estimateMessageTokens(messages, charsPerToken);

  const conversationText = messages
    .map((m) => {
      const role = m.role.toUpperCase();
      const content = messageContentChars(m);
      if (content > 0) {
        const text = typeof m.content === "string" ? m.content : String(content);
        return `[${role}] ${text.slice(0, 500)}`;
      }
      if (m.role === "tool" && "toolCallId" in m) {
        return `[TOOL] result for ${m.toolCallId}`;
      }
      return `[${role}]`;
    })
    .join("\n");

  const systemPrompt = [
    "You are a conversation summarizer. Produce a concise summary of the conversation below.",
    "",
    "Rules:",
    "- Include key facts, decisions made, code written, and results obtained",
    "- Keep the summary under 200 words",
    "- Write in plain English, in paragraph form",
    "- Do NOT use markdown headings or bullet lists",
    "- Preserve technical details (file names, function names, error messages) verbatim",
    "",
    `The conversation to summarize is ~${tokenCount} tokens across ${messages.length} messages.`,
    previousSummary
      ? `\nPrevious summary (merge new info into this):\n${previousSummary}`
      : "",
  ].join("\n");

  const textParts: string[] = [];
  const gen = llmClient.stream({
    model,
    systemPrompt,
    messages: [userMessage(conversationText)],
    maxTokens: 500,
  });

  for await (const chunk of gen) {
    if (chunk.type === "text-delta") {
      textParts.push(chunk.delta);
    } else if (chunk.type === "error") {
      throw new Error(`Compression failed: ${chunk.error.message}`);
    }
  }

  return textParts.join("").trim() || "(summary unavailable)";
}

/**
 * Merge new incoming messages into the context window.
 * Deduplicates against existing messages using suffix matching.
 */
function mergeContextMessages(
  existing: Message[],
  incoming: Message[],
): Message[] {
  if (existing.length === 0) return [...incoming];
  if (incoming.length === 0) return existing;

  // Check if existing is a suffix of incoming (typical case: history reload)
  if (incoming.length >= existing.length) {
    const tail = incoming.slice(incoming.length - 4);
    const existingTail = existing.slice(-4);
    if (countMatchingSuffix(tail, existingTail) > 0) {
      // Find exact overlap point and append only new messages
      const overlap = findOverlapEnd(incoming, existing);
      const newOnly = incoming.slice(overlap);
      return newOnly.length > 0 ? [...existing, ...newOnly] : existing;
    }
  }

  // Fallback: incoming replaces existing (session resume with different messages)
  return [...incoming];
}

function countMatchingSuffix(a: Message[], b: Message[]): number {
  let count = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (messageFingerprint(a[a.length - 1 - i]) === messageFingerprint(b[b.length - 1 - i])) {
      count++;
    } else break;
  }
  return count;
}

function findOverlapEnd(larger: Message[], smaller: Message[]): number {
  for (let end = larger.length; end >= 0; end--) {
    const prefix = larger.slice(0, end);
    if (prefix.length >= smaller.length) {
      const tail = prefix.slice(-smaller.length);
      if (countMatchingSuffix(tail, smaller) === smaller.length) return end;
    }
  }
  return 0;
}

function messageFingerprint(msg: Message): string {
  const content = typeof msg.content === "string"
    ? msg.content
    : Array.isArray(msg.content)
      ? msg.content.map((b) => ("text" in b ? b.text : "")).join("")
      : "";
  return `${msg.role}:${content.slice(0, 80)}`;
}

// ── Plugin ──────────────────────────────────────────

export function withContextCompression(opts: WithContextCompressionOptions): Plugin {
  const maxTokens = opts.maxTokens;
  const charsPerToken = opts.charsPerToken ?? 4;
  const keepLastN = opts.keepLastN ?? 5;
  const sessionId = opts.sessionId;

  // Initialize or resume context state
  if (!_state) {
    _state = {
      messages: [],
      summary: null,
      sessionId: null,
      filePath: null,
      dirty: false,
    };
  }
  const state = _state;

  return (inner) =>
    async function* (input: AgentInput): AgentGenerator {
      const incoming = input.messages ?? [];

      // ── Session resume: load context from file ────
      if (sessionId && state.sessionId !== sessionId) {
        state.sessionId = sessionId;
        state.filePath = contextFilePath(sessionId);

        const saved = loadContext(sessionId);
        if (saved) {
          state.messages = saved.messages;
          state.summary = saved.summary;
          // Merge incoming into loaded context
          state.messages = mergeContextMessages(state.messages, incoming);
          state.dirty = state.filePath !== null;
        } else {
          state.messages = [...incoming];
          state.summary = null;
          state.dirty = true;
        }
      } else if (!sessionId && state.sessionId !== null) {
        // No session tracking — use in-memory only
        state.sessionId = null;
        state.filePath = null;
        state.messages = mergeContextMessages(state.messages, incoming);
      } else {
        // Same session — merge incoming
        state.messages = mergeContextMessages(state.messages, incoming);
        state.dirty = state.filePath !== null;
      }

      // ── Check token budget ──────────────────────
      const totalTokens = estimateMessageTokens(state.messages, charsPerToken);

      if (totalTokens > maxTokens && state.messages.length > keepLastN) {
        const compressCount = state.messages.length - keepLastN;
        const toCompress = state.messages.slice(0, compressCount);
        const recent = state.messages.slice(compressCount);

        const llmClient = input.llmClient ?? getDefaultLLMClient();
        const model = opts.model ?? input.model;

        try {
          const summary = await generateSummary(
            llmClient, model, toCompress, state.summary, charsPerToken,
          );

          state.summary = summary;
          state.messages = [
            userMessage(`[Previous conversation summary]\n${summary}`),
            ...recent,
          ];
          state.dirty = true;
        } catch (err) {
          console.error(
            "[withContextCompression] Summarization failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // ── Persist context after modifications ─────
      if (state.dirty) {
        saveContext(state);
      }

      // ── Pass context window to downstream, collect assistant response ──
      const textParts: string[] = [];
      const toolCalls: ToolCall[] = [];
      const toolMessages: Message[] = [];

      for await (const event of inner({ ...input, messages: state.messages })) {
        switch (event.type) {
          case "llm:delta":
            textParts.push(event.delta);
            break;
          case "llm:tool-call":
            toolCalls.push({ id: event.id, name: event.name, arguments: event.arguments });
            break;
          case "tool:result":
            toolMessages.push({ role: "tool", toolCallId: event.callId, content: JSON.stringify(event.output) });
            break;
          case "tool:error":
            toolMessages.push({ role: "tool", toolCallId: event.callId, content: event.error });
            break;
        }
        yield event;
      }

      // ── Append assistant response to context window ─────
      const text = textParts.join("").trim();
      const hasContent = text.length > 0 || toolCalls.length > 0;
      if (hasContent) {
        state.messages.push(
          assistantMessage(
            text || null,
            toolCalls.length > 0 ? toolCalls : undefined,
          ),
        );
      }
      if (toolMessages.length > 0) {
        state.messages.push(...toolMessages);
      }
      if (hasContent || toolMessages.length > 0) {
        state.dirty = state.filePath !== null;
      }

      // Persist context with new assistant messages
      if (state.dirty) {
        saveContext(state);
      }
    };
}
