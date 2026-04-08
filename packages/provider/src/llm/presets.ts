import { createAnthropicAdapter } from "./adapters/anthropic-adapter";
import { createMinimaxAdapter } from "./minimax";
import { createOpenAIAdapter } from "./adapters/openai-adapter";
import { createRegistry } from "./registry";
import type { LLMAdapter } from "./adapter";
import type { LLMRegistry } from "./registry";

/** Built-in adapter factories, keyed by vendor id. */
const ADAPTER_FACTORIES: Record<string, () => LLMAdapter> = {
  openai: createOpenAIAdapter,
  anthropic: createAnthropicAdapter,
  minimax: createMinimaxAdapter,
};

/** Create a registry that only includes the given vendors. */
export function createRegistryForVendors(vendorIds: string[]): LLMRegistry {
  const adapters: LLMAdapter[] = [];
  for (const id of vendorIds) {
    const factory = ADAPTER_FACTORIES[id];
    if (!factory) {
      throw new Error(
        `Unknown vendor "${id}". Available: ${Object.keys(ADAPTER_FACTORIES).join(", ")}`,
      );
    }
    adapters.push(factory());
  }
  return createRegistry(adapters);
}
