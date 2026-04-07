import { MINIMAXI_VENDOR_ID } from "./minimaxi/credentials";

/** `openai/gpt-4o-mini` — 等价于字符串，便于与 AI SDK 风格对齐。 */
export function openai(modelId: string): string {
  return `openai/${modelId}`;
}

/** `anthropic/claude-...` */
export function anthropic(modelId: string): string {
  return `anthropic/${modelId}`;
}

/** `minimaxi/...` */
export function minimaxi(modelId: string): string {
  return `${MINIMAXI_VENDOR_ID}/${modelId}`;
}
