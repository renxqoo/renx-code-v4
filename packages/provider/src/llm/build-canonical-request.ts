import { LLMError } from "./errors";
import { extractVendorOptions } from "./internal/provider-options";
import type {
  CanonicalMessage,
  CanonicalRequest,
  CanonicalTool,
  MessagePart,
  ModelHandle,
  ToolChoice,
} from "./types";

function userContentFromPrompt(prompt: string | MessagePart[]): MessagePart[] {
  if (typeof prompt === "string") {
    return [{ type: "text", text: prompt }];
  }
  if (prompt.length === 0) {
    throw new LLMError({
      code: "INVALID_REQUEST",
      message: "prompt as MessagePart[] must not be empty",
      retryable: false,
    });
  }
  return prompt;
}

export type BuildCanonicalRequestInput = {
  handle: ModelHandle;
  /** 与 `messages` 使用同一套 `MessagePart`；纯字符串等价于单段文本。 */
  prompt?: string | MessagePart[];
  messages?: CanonicalMessage[];
  /** Shortcut: prepend a system message before user/assistant messages. */
  systemPrompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  stopSequences?: string[];
  providerOptions?: Record<string, unknown>;
  tools?: CanonicalTool[];
  toolChoice?: ToolChoice;
};

/** Known vendor IDs used as providerOptions namespace keys. */
const VENDOR_NAMESPACES = new Set(["openai", "anthropic", "minimax", "echo"]);

function mergeProviderOptions(
  a?: Record<string, unknown>,
  b?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!a && !b) return undefined;
  const out: Record<string, unknown> = { ...a, ...b };
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) {
    const va = a?.[k];
    const vb = b?.[k];
    if (
      va &&
      vb &&
      typeof va === "object" &&
      typeof vb === "object" &&
      !Array.isArray(va) &&
      !Array.isArray(vb)
    ) {
      out[k] = { ...(va as object), ...(vb as object) };
    }
  }
  return out;
}

export function buildCanonicalRequest(input: BuildCanonicalRequestInput): CanonicalRequest {
  const userMessages =
    input.messages ??
    (input.prompt !== undefined
      ? [
          {
            role: "user" as const,
            content: userContentFromPrompt(input.prompt),
          },
        ]
      : undefined);

  if (!userMessages || userMessages.length === 0) {
    throw new LLMError({
      code: "INVALID_REQUEST",
      message: "Either messages or prompt is required",
      retryable: false,
    });
  }

  const messages: CanonicalMessage[] = input.systemPrompt
    ? [{ role: "system", content: [{ type: "text", text: input.systemPrompt }] }, ...userMessages]
    : userMessages;

  const merged = mergeProviderOptions(input.handle.providerOptions, input.providerOptions);
  const providerOptions = extractVendorOptions(merged, input.handle.vendorId, VENDOR_NAMESPACES);

  return {
    modelId: input.handle.modelId,
    messages,
    params: {
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
      topP: input.topP,
      stopSequences: input.stopSequences,
    },
    providerOptions,
    tools: input.tools,
    toolChoice: input.toolChoice,
  };
}
