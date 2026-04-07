import { createAnthropicAdapter } from "./adapters/anthropic-adapter";
import { createMinimaxiAdapter } from "./minimaxi";
import { createOpenAIAdapter } from "./adapters/openai-adapter";
import { createRegistry } from "./registry";
import type { LLMRegistry } from "./registry";

export function createOpenAIAndAnthropicRegistry(): LLMRegistry {
  return createRegistry([createOpenAIAdapter(), createAnthropicAdapter()]);
}

export function createMinimaxiRegistry(): LLMRegistry {
  return createRegistry([createMinimaxiAdapter()]);
}

export function createOpenAIAnthropicAndMinimaxiRegistry(): LLMRegistry {
  return createRegistry([
    createOpenAIAdapter(),
    createAnthropicAdapter(),
    createMinimaxiAdapter(),
  ]);
}
