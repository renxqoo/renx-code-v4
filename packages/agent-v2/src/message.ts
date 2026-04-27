export type SystemMessage = {
  role: "system";
  content: string;
};

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "tool_result"; toolCallId: string; content: string };

export type UserMessage = {
  role: "user";
  content: string | ContentBlock[];
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type AssistantMessage = {
  role: "assistant";
  content: string | null;
  toolCalls?: ToolCall[];
};

export type ToolMessage = {
  role: "tool";
  toolCallId: string;
  content: string;
};

export type Message =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;

export function systemMessage(content: string): SystemMessage {
  return { role: "system", content };
}

export function userMessage(content: string): UserMessage {
  return { role: "user", content };
}

export function assistantMessage(
  content: string | null,
  toolCalls?: ToolCall[],
): AssistantMessage {
  return { role: "assistant", content, ...(toolCalls?.length ? { toolCalls } : {}) };
}

export function toolMessage(toolCallId: string, content: string): ToolMessage {
  return { role: "tool", toolCallId, content };
}
