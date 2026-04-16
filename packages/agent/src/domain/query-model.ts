import type { GenerateTextOptions } from "@renx/provider";
import type { Message } from "./message";

/** 一次 `streamText` 调用：在 Provider 文本选项上固定 `messages` / `systemPrompt` 形状。 */
export type QueryModelType = Omit<GenerateTextOptions, "messages" | "prompt"> & {
  systemPrompt: string;
  messages: Message[];
};
