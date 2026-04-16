import type { CanonicalToolCall, MessagePart } from "@renx/provider";
import type { Message } from "../domain/message";
import type { AgentToolExecutionResult } from "../tools/type";

/** 将本轮 assistant 文本 + tool_calls 追加到对话（返回新数组，不修改原数组）。 */
export function appendAssistantToolRound(
  messages: Message[],
  assistantText: string,
  toolCalls: CanonicalToolCall[],
): Message[] {
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
  return [...messages, { role: "assistant", content }];
}

/** 每条 `role: tool` 消息对应一个 tool_call_id。返回新数组，不修改原数组。 */
export function appendToolResultMessages(
  messages: Message[],
  toolCalls: CanonicalToolCall[],
  results: AgentToolExecutionResult[],
): Message[] {
  const appended: Message[] = [];
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    const r = results[i];
    const text =
      r?.content ??
      (r?.success === false ? "Tool execution failed with no message." : "");
    appended.push({
      role: "tool",
      content: [{ type: "tool_result", toolCallId: tc.id, content: text }],
    });
  }
  return [...messages, ...appended];
}

/** 追加纯文本 assistant 消息。返回新数组，不修改原数组。 */
export function appendAssistantTextOnly(messages: Message[], assistantText: string): Message[] {
  if (!assistantText) {
    return messages;
  }
  return [
    ...messages,
    {
      role: "assistant",
      content: [{ type: "text", text: assistantText }],
    },
  ];
}
