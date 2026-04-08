import type { ModelHandle } from "./types";

/** `openai/gpt-4o-mini` */
export function openai(modelId: string): string {
  return `openai/${modelId}`;
}

/** `anthropic/claude-...` */
export function anthropic(modelId: string): string {
  return `anthropic/${modelId}`;
}

/** `minimax/...` */
export function minimax(modelId: string): string;
export function minimax(modelId: string, providerOptions: Record<string, unknown>): ModelHandle;
export function minimax(
  modelId: string,
  providerOptions?: Record<string, unknown>,
): string | ModelHandle {
  if (providerOptions === undefined) {
    return `minimax/${modelId}`;
  }
  return {
    modelId,
    vendorId: "minimax",
    providerOptions,
  };
}
