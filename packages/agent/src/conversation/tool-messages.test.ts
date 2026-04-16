import { describe, expect, it } from "vitest";
import {
  appendAssistantTextOnly,
  appendAssistantToolRound,
  appendToolResultMessages,
} from "./tool-messages";
import type { CanonicalToolCall } from "@renx/provider";
import type { AgentToolExecutionResult } from "../tools/type";

describe("appendAssistantTextOnly", () => {
  it("returns a new array with the text message appended", () => {
    const original: unknown[] = [];
    const result = appendAssistantTextOnly(original as any, "hello");
    expect(result).toHaveLength(1);
    expect(result).not.toBe(original);
    expect(result[0]).toEqual({ role: "assistant", content: [{ type: "text", text: "hello" }] });
  });

  it("returns the same array reference when text is empty", () => {
    const original: unknown[] = [];
    const result = appendAssistantTextOnly(original as any, "");
    expect(result).toBe(original);
  });
});

describe("appendAssistantToolRound", () => {
  it("returns a new array with assistant + tool_calls", () => {
    const original: unknown[] = [];
    const calls: CanonicalToolCall[] = [
      { id: "c1", name: "read_file", arguments: '{"path":"/tmp"}' },
    ];
    const result = appendAssistantToolRound(original as any, "thinking", calls);
    expect(result).toHaveLength(1);
    expect(result).not.toBe(original);
    const msg = result[0] as any;
    expect(msg.role).toBe("assistant");
    expect(msg.content).toHaveLength(2); // text + tool_call
  });
});

describe("appendToolResultMessages", () => {
  it("returns a new array with tool results", () => {
    const original: unknown[] = [{ role: "assistant", content: [] }];
    const calls: CanonicalToolCall[] = [
      { id: "c1", name: "read_file", arguments: '{}' },
    ];
    const results: AgentToolExecutionResult[] = [
      { success: true, content: "file contents", metadata: {} },
    ];
    const appended = appendToolResultMessages(original as any, calls, results);
    expect(appended).toHaveLength(2);
    expect(appended).not.toBe(original);
    expect(appended[1]).toEqual({
      role: "tool",
      content: [{ type: "tool_result", toolCallId: "c1", content: "file contents" }],
    });
  });

  it("does not mutate the original array", () => {
    const original: unknown[] = [];
    const calls: CanonicalToolCall[] = [
      { id: "c1", name: "t", arguments: '{}' },
    ];
    const results: AgentToolExecutionResult[] = [
      { success: true, content: "ok", metadata: {} },
    ];
    appendToolResultMessages(original as any, calls, results);
    expect(original).toHaveLength(0);
  });
});
