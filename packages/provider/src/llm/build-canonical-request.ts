import { LLMError } from "./errors";
import type { CanonicalMessage, CanonicalRequest, ModelHandle } from "./types";

export type BuildCanonicalRequestInput = {
  handle: ModelHandle;
  prompt?: string;
  messages?: CanonicalMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  stopSequences?: string[];
  providerOptions?: Record<string, unknown>;
};

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

export function buildCanonicalRequest(
  input: BuildCanonicalRequestInput,
): CanonicalRequest {
  const messages =
    input.messages ??
    (input.prompt !== undefined
      ? [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: input.prompt }],
          },
        ]
      : undefined);

  if (!messages || messages.length === 0) {
    throw new LLMError({
      code: "INVALID_REQUEST",
      message: "Either messages or prompt is required",
      retryable: false,
    });
  }

  const providerOptions = mergeProviderOptions(
    input.handle.providerOptions,
    input.providerOptions,
  );

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
  };
}
