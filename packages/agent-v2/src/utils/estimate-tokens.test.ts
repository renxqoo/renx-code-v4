import { describe, expect, it } from "vitest";
import { estimateInputTokens, estimateOutputTokens } from "./estimate-tokens.js";
import type { Message } from "../message.js";
import type { LLMToolCallEvent } from "../events.js";
import { systemMessage, userMessage, assistantMessage, toolMessage } from "../message.js";
import type { CanonicalToolSchema } from "../llm-client.js";

describe("estimateInputTokens", () => {
  it("returns zero for empty inputs", () => {
    expect(estimateInputTokens("", [])).toBe(0);
  });

  it("estimates based on chars/4 ratio for system prompt", () => {
    // 40 chars → ~10 tokens
    const prompt = "You are a helpful assistant with rules.";
    const tokens = estimateInputTokens(prompt, []);
    expect(tokens).toBe(Math.ceil(prompt.length / 4));
    expect(tokens).toBeGreaterThan(0);
  });

  it("estimates message content using chars/4 + overhead", () => {
    // "Hello" = 5 chars / 4 = 1.25 → 2 tokens + 4 overhead = 6
    const messages: Message[] = [userMessage("Hello")];
    const tokens = estimateInputTokens("", messages);
    const expected = Math.ceil(5 / 4 + 4); // content + overhead
    expect(tokens).toBe(expected);
  });

  it("includes structural overhead per message (~4 tokens)", () => {
    const messages: Message[] = [
      userMessage("A"),
      userMessage("B"),
    ];
    // 2 * (1 char/4 + 4 overhead) = 2 * 5 = 10
    const tokens = estimateInputTokens("", messages);
    expect(tokens).toBe(Math.ceil(2 * (1 / 4 + 4)));
  });

  it("handles messages with different content types", () => {
    const messages: Message[] = [
      systemMessage("System rules"),
      userMessage("User question"),
      assistantMessage("Assistant answer"),
      toolMessage("call_1", "Tool result content"),
    ];
    const tokens = estimateInputTokens("", messages);
    // 4 messages → 4*4 = 16 overhead
    const contentLength =
      12 + // "System rules"
      13 + // "User question"
      16 + // "Assistant answer"
      18;  // "Tool result content"
    const expected = Math.ceil(contentLength / 4 + 4 * 4);
    expect(tokens).toBe(expected);
  });

  it("handles assistant messages with null content", () => {
    const messages: Message[] = [
      assistantMessage(null, [{ id: "t1", name: "search", arguments: { q: "test" } }]),
    ];
    const tokens = estimateInputTokens("", messages);
    // 0 chars content + 4 overhead = 4
    expect(tokens).toBe(4);
  });

  it("handles user messages with ContentBlock[]", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this image" },
          { type: "image", url: "https://example.com/img.png" },
          { type: "tool_result", toolCallId: "tc1", content: "Result data" },
        ],
      },
    ];
    const tokens = estimateInputTokens("", messages);
    // Content: "Look at this image" (18) + "Result data" (11) = 29 chars / 4 + 4 overhead → ceil(11.25) = 12
    const textLen = 18 + 11;
    const expected = Math.ceil(textLen / 4 + 4);
    expect(tokens).toBe(expected);
  });

  it("includes tool definitions in input estimation", () => {
    const tools: CanonicalToolSchema[] = [
      {
        name: "search",
        description: "Search the web",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    ];
    const messages: Message[] = [userMessage("Query")];
    const withoutTools = estimateInputTokens("", messages);
    const withTools = estimateInputTokens("", messages, tools);

    const toolChars =
      6 + // "search"
      14 + // "Search the web"
      JSON.stringify(tools[0]!.parameters).length;

    expect(withTools).toBeGreaterThan(withoutTools);

    // ceil(x+y) ≠ ceil(x)+ceil(y) when fractional parts cross a boundary.
    // Verify the contribution is within ±1 of the raw calculation.
    const diff = withTools - withoutTools;
    const rawToolTokens = toolChars / 4;
    expect(diff).toBeGreaterThanOrEqual(Math.floor(rawToolTokens));
    expect(diff).toBeLessThanOrEqual(Math.ceil(rawToolTokens));
  });

  it("includes system prompt alongside messages", () => {
    const prompt = "You are a bot.";
    const messages: Message[] = [userMessage("Hi")];
    const tokens = estimateInputTokens(prompt, messages);
    // prompt: 14/4 = 3.5 → 4; msg: 2/4 = 0.5 + 4 → 1 → 5; total = 9
    const expected = Math.ceil(prompt.length / 4 + 2 / 4 + 4);
    expect(tokens).toBe(expected);
  });
});

describe("estimateOutputTokens", () => {
  it("returns zero for empty text and no tool calls", () => {
    expect(estimateOutputTokens("", [])).toBe(0);
  });

  it("estimates text output using chars/4", () => {
    // 20 chars → 5 tokens
    const text = "I am a response text";
    const tokens = estimateOutputTokens(text, []);
    expect(tokens).toBe(Math.ceil(text.length / 4));
    expect(tokens).toBeGreaterThan(0);
  });

  it("includes tool call overhead (~10 + args and name / 4)", () => {
    const tc: LLMToolCallEvent = {
      type: "llm:tool-call",
      step: 1,
      id: "call_1",
      name: "search",
      arguments: { q: "hello world" },
    };
    const tokens = estimateOutputTokens("", [tc]);
    // 10 overhead + (6 + ?) args/4
    const argsStr = JSON.stringify(tc.arguments);
    const expected = Math.ceil(10 + (tc.name.length + argsStr.length) / 4);
    expect(tokens).toBe(expected);
  });

  it("combines text and tool call estimates", () => {
    const text = "Response";
    const tc: LLMToolCallEvent = {
      type: "llm:tool-call",
      step: 1,
      id: "c1",
      name: "calc",
      arguments: { expr: "2+2" },
    };
    const tokens = estimateOutputTokens(text, [tc]);
    const argsStr = JSON.stringify(tc.arguments);
    const expected = Math.ceil(text.length / 4 + 10 + (tc.name.length + argsStr.length) / 4);
    expect(tokens).toBe(expected);
  });

  it("handles multiple tool calls", () => {
    const tcs: LLMToolCallEvent[] = [
      { type: "llm:tool-call", step: 1, id: "a", name: "read", arguments: { path: "/x" } },
      { type: "llm:tool-call", step: 1, id: "b", name: "write", arguments: { path: "/y", content: "data" } },
    ];
    const tokens = estimateOutputTokens("", tcs);
    let expected = 0;
    for (const tc of tcs) {
      const args = JSON.stringify(tc.arguments);
      expected += 10 + (tc.name.length + args.length) / 4;
    }
    expect(tokens).toBe(Math.ceil(expected));
  });
});
