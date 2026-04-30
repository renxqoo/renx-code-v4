import type { Message } from "../message.js";
import type { CanonicalToolSchema } from "../llm-client.js";
import type { LLMToolCallEvent } from "../events.js";

const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD = 4; // ~4 tokens per message (role markers, formatting)
const TOOL_CALL_OVERHEAD = 10; // ~10 tokens per tool call (structural tokens)

/**
 * Extract the total character length of text content from a Message.
 * Handles string content, ContentBlock[] arrays, and null (assistant w/o text).
 */
function messageContentLength(msg: Message): number {
  if (typeof msg.content === "string") {
    return msg.content.length;
  }
  if (Array.isArray(msg.content)) {
    let len = 0;
    for (const block of msg.content) {
      if (block.type === "text") {
        len += block.text.length;
      } else if (block.type === "tool_result") {
        len += block.content.length;
      }
      // image blocks don't contribute to text-based estimation
    }
    return len;
  }
  // null content (assistant message with tool calls only)
  return 0;
}

/**
 * Estimate input token count using chars/4 heuristic + structural overhead.
 *
 * Includes:
 * - systemPrompt length / 4
 * - Each message's content length / 4 + 4 tokens overhead
 * - Each tool definition: (name + description + JSON params) / 4
 */
export function estimateInputTokens(
  systemPrompt: string,
  messages: Message[],
  tools?: CanonicalToolSchema[],
): number {
  let tokens = 0;

  // System prompt
  tokens += systemPrompt.length / CHARS_PER_TOKEN;

  // Messages
  for (const msg of messages) {
    tokens += messageContentLength(msg) / CHARS_PER_TOKEN;
    tokens += MESSAGE_OVERHEAD;
  }

  // Tools
  if (tools) {
    for (const tool of tools) {
      const params = JSON.stringify(tool.parameters);
      tokens +=
        (tool.name.length + tool.description.length + params.length) /
        CHARS_PER_TOKEN;
    }
  }

  return Math.ceil(tokens);
}

/**
 * Estimate output token count using chars/4 heuristic.
 *
 * Includes:
 * - accumulated text length / 4
 * - Per tool call: 10 tokens overhead + (name + JSON args) / 4
 */
export function estimateOutputTokens(
  text: string,
  toolCalls: LLMToolCallEvent[],
): number {
  let tokens = 0;

  // Text
  tokens += text.length / CHARS_PER_TOKEN;

  // Tool calls
  for (const tc of toolCalls) {
    const args = JSON.stringify(tc.arguments);
    tokens += TOOL_CALL_OVERHEAD + (tc.name.length + args.length) / CHARS_PER_TOKEN;
  }

  return Math.ceil(tokens);
}
