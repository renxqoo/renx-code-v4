import { LLMError } from "./errors";
import type { LLMAdapter } from "./adapter";

export class LLMRegistry {
  private readonly adapters = new Map<string, LLMAdapter>();

  register(adapter: LLMAdapter, options?: { overwrite?: boolean }): void {
    if (this.adapters.has(adapter.vendorId) && !options?.overwrite) {
      throw new LLMError({
        code: "INVALID_REQUEST",
        message: `LLM adapter already registered: ${adapter.vendorId}`,
        retryable: false,
      });
    }
    this.adapters.set(adapter.vendorId, adapter);
  }

  get(vendorId: string): LLMAdapter {
    const a = this.adapters.get(vendorId);
    if (!a) {
      throw new LLMError({
        code: "MODEL_NOT_FOUND",
        message: `Unknown vendor: ${vendorId}`,
        retryable: false,
      });
    }
    return a;
  }

  has(vendorId: string): boolean {
    return this.adapters.has(vendorId);
  }
}

export function createRegistry(adapters: LLMAdapter[]): LLMRegistry {
  const r = new LLMRegistry();
  for (const a of adapters) {
    r.register(a);
  }
  return r;
}
