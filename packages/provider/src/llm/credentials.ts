export function createStaticApiKeyResolver(
  keys: Partial<Record<string, string>>,
): (vendorId: string) => string | undefined {
  return (vendorId) => keys[vendorId];
}

function readProcessEnv(): Record<string, string | undefined> {
  const proc = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return proc?.env ?? {};
}

import { MINIMAX_VENDOR_ID } from "./minimax/credentials";

export function createEnvApiKeyResolver(
  env?: Record<string, string | undefined>,
): (vendorId: string) => string | undefined {
  const e = env ?? readProcessEnv();
  return (vendorId) => {
    if (vendorId === "openai") return e.OPENAI_API_KEY;
    if (vendorId === "anthropic") return e.ANTHROPIC_API_KEY;
    if (vendorId === MINIMAX_VENDOR_ID) return e.MINIMAX_API_KEY;
    return undefined;
  };
}
