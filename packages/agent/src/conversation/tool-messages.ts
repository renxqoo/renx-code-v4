import type { CanonicalToolCall, MessagePart } from "@renx/provider";
import type { Message } from "../domain/message";
import type { AgentToolExecutionResult } from "../tools/type";

/** 将本轮 assistant 文本 + tool_calls 追加到对话（与 `CanonicalMessage` / `MessagePart` 一致）。 */
export function appendAssistantToolRound(
  messages: Message[],
  assistantText: string,
  toolCalls: CanonicalToolCall[],
): void {
  const content: MessagePart[] = [];
  if (assistantText) {
    content.push({ type: "text", text: assistantText });
  }
  for (const tc of toolCalls) {
    content.push({
      type: "tool_call",
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    });
  }
  messages.push({ role: "assistant", content });
}

/** 每条 `role: tool` 消息对应一个 tool_call_id（便于各厂商 adapter 映射）。 */
export function appendToolResultMessages(
  messages: Message[],
  toolCalls: CanonicalToolCall[],
  results: AgentToolExecutionResult[],
): void {
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    const r = results[i];
    const text =
      r?.content ??
      (r?.success === false ? "Tool execution failed with no message." : "");
    messages.push({
      role: "tool",
      content: [{ type: "tool_result", toolCallId: tc.id, content: text }],
    });
  }
}

export function appendAssistantTextOnly(messages: Message[], assistantText: string): void {
  if (!assistantText) {
    return;
  }
  messages.push({
    role: "assistant",
    content: [{ type: "text", text: assistantText }],
  });
}
