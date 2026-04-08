import type { MessagePart, TextPart } from "./types";

export function flattenTextParts(parts: TextPart[]): string {
  return parts.map((p) => p.text).join("");
}

export function hasNonTextPart(parts: MessagePart[]): boolean {
  return parts.some((p) => p.type !== "text" && p.type !== "tool_call" && p.type !== "tool_result");
}

/** OpenAI Chat Completions：`content` 统一为 parts 数组（含纯文本）。 */
export function openAIContentForMessage(parts: MessagePart[]): unknown[] {
  return parts.map((p) => {
    if (p.type === "text") {
      return { type: "text", text: p.text };
    }
    if (p.type === "image_url") {
      return {
        type: "image_url",
        image_url: {
          url: p.url,
          ...(p.detail != null ? { detail: p.detail } : {}),
        },
      };
    }
    if (p.type === "image_base64") {
      return {
        type: "image_url",
        image_url: {
          url: `data:${p.mediaType};base64,${p.data}`,
        },
      };
    }
    return p;
  });
}

/** Anthropic Messages API 的 user 内容块数组。 */
export function anthropicContentBlocks(parts: MessagePart[]): unknown[] {
  return parts.map((p) => {
    if (p.type === "text") {
      return { type: "text", text: p.text };
    }
    if (p.type === "image_url") {
      return { type: "image", source: { type: "url", url: p.url } };
    }
    if (p.type === "image_base64") {
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: p.mediaType,
          data: p.data,
        },
      };
    }
    return p;
  });
}

/** Echo 等本地适配器：将多段内容压成单行可读字符串。 */
export function flattenMessagePartsForEcho(parts: MessagePart[]): string {
  return parts
    .map((p) => {
      if (p.type === "text") return p.text;
      if (p.type === "image_url") return `[image:url:${p.url}]`;
      if (p.type === "image_base64") return `[image:base64:${p.mediaType}]`;
      return "";
    })
    .join("");
}
