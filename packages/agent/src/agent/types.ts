import type { CanonicalFinishReason, CanonicalStreamChunk } from "@renx/provider";
import type { Message } from "../domain/message";
import type { RuntimeOutcome } from "../model/runtime";
import type { ToolRegistry } from "../tools/registry";

export type AgentConstructorConfig = {
  maxSteps: number;
  registry?: ToolRegistry;
};

export type QueryModelOutcome = {
  messages: Message[];
  finishReason: CanonicalFinishReason;
  llmRounds: number;
  lastStream: RuntimeOutcome;
  error?: unknown;
};

export type QueryModelHooks = {
  /** 每轮 LLM 消费 `textStream` 时触发；多轮工具循环下每一轮都会回调。 */
  onStreamChunk?: (chunk: CanonicalStreamChunk) => void | Promise<void>;
};
