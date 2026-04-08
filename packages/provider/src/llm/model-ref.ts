import { LLMError } from "./errors";
import type { ModelHandle } from "./types";

export function modelRef(
  vendorId: string,
  modelId: string,
  options?: { providerOptions?: Record<string, unknown> },
): ModelHandle {
  return {
    vendorId,
    modelId,
    providerOptions: options?.providerOptions,
  };
}

export function parseModelRefString(ref: string): ModelHandle {
  const idx = ref.indexOf("/");
  if (idx <= 0 || idx === ref.length - 1) {
    throw new LLMError({
      code: "MODEL_NOT_FOUND",
      message: `Invalid model reference: "${ref}". Expected format: vendorId/modelId (e.g. "openai/gpt-4o")`,
      retryable: false,
    });
  }
  return {
    vendorId: ref.slice(0, idx),
    modelId: ref.slice(idx + 1),
  };
}

export function normalizeModel(model: ModelHandle | string): ModelHandle {
  return typeof model === "string" ? parseModelRefString(model) : model;
}
