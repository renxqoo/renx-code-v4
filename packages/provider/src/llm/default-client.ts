import { createLLMClient, type LLMClient, type LLMClientConfig } from "./client";
import { createEnvApiKeyResolver, createStaticApiKeyResolver } from "./credentials";
import { createRegistryForVendors } from "./presets";
import type { LLMRegistry } from "./registry";

export type CreateDefaultLLMClientOptions = Omit<LLMClientConfig, "registry" | "resolveApiKey"> & {
  /** 若传入则忽略 `vendors` */
  registry?: LLMRegistry;
  /**
   * 要注册的厂商 ID 列表，默认 `["openai", "anthropic", "minimax"]`。
   * 内置厂商: `"openai"`, `"anthropic"`, `"minimax"`
   */
  vendors?: string[];
  /**
   * 按厂商显式密钥；会覆盖该厂商在环境变量中的值。
   * 未列出的厂商在 `useEnv !== false` 时仍读 `OPENAI_API_KEY` 等。
   */
  apiKeys?: Partial<Record<string, string>>;
  /** 默认 `true`：与 `apiKeys` 合并解析 */
  useEnv?: boolean;
};

/**
 * 默认注册表 + 环境变量密钥，一行创建 Client（仍可覆写 `baseUrlByVendor`、`fetch` 等）。
 * 需要多租户或完全自定义注册表时，请继续用 `createLLMClient`。
 */
export function createDefaultLLMClient(options: CreateDefaultLLMClientOptions = {}): LLMClient {
  const {
    registry: registryOverride,
    vendors = ["openai", "anthropic", "minimax"],
    apiKeys,
    useEnv = true,
    ...rest
  } = options;

  const registry = registryOverride ?? createRegistryForVendors(vendors);

  const envResolver = useEnv ? createEnvApiKeyResolver() : (): undefined => undefined;
  const staticResolver = apiKeys ? createStaticApiKeyResolver(apiKeys) : (): undefined => undefined;

  const resolveApiKey = (vendorId: string): string | undefined => {
    const fromExplicit = staticResolver(vendorId);
    if (fromExplicit !== undefined && fromExplicit !== "") {
      return fromExplicit;
    }
    return envResolver(vendorId);
  };

  return createLLMClient({
    ...rest,
    registry,
    resolveApiKey,
  });
}
