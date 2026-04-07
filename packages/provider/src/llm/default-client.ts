import { createLLMClient, type LLMClient, type LLMClientConfig } from "./client";
import { createEnvApiKeyResolver, createStaticApiKeyResolver } from "./credentials";
import {
  createMinimaxiRegistry,
  createOpenAIAndAnthropicRegistry,
  createOpenAIAnthropicAndMinimaxiRegistry,
} from "./presets";
import type { LLMRegistry } from "./registry";

export type DefaultLLMPreset =
  | "openai-anthropic"
  | "openai-anthropic-minimaxi"
  | "minimaxi-only";

export type CreateDefaultLLMClientOptions = Omit<
  LLMClientConfig,
  "registry" | "resolveApiKey"
> & {
  /** 若传入则忽略 `preset` */
  registry?: LLMRegistry;
  /** 默认仅 OpenAI + Anthropic（无需 MiniMax Key） */
  preset?: DefaultLLMPreset;
  /**
   * 按厂商显式密钥；会覆盖该厂商在环境变量中的值。
   * 未列出的厂商在 `useEnv !== false` 时仍读 `OPENAI_API_KEY` 等。
   */
  apiKeys?: Partial<Record<string, string>>;
  /** 默认 `true`：与 `apiKeys` 合并解析 */
  useEnv?: boolean;
};

function registryForPreset(p: DefaultLLMPreset): LLMRegistry {
  switch (p) {
    case "openai-anthropic-minimaxi":
      return createOpenAIAnthropicAndMinimaxiRegistry();
    case "minimaxi-only":
      return createMinimaxiRegistry();
    default:
      return createOpenAIAndAnthropicRegistry();
  }
}

/**
 * 默认注册表 + 环境变量密钥，一行创建 Client（仍可覆写 `baseUrlByVendor`、`fetch` 等）。
 * 需要多租户或完全自定义注册表时，请继续用 `createLLMClient`。
 */
export function createDefaultLLMClient(
  options: CreateDefaultLLMClientOptions = {},
): LLMClient {
  const {
    registry: registryOverride,
    preset = "openai-anthropic",
    apiKeys,
    useEnv = true,
    ...rest
  } = options;

  const registry = registryOverride ?? registryForPreset(preset);

  const envResolver = useEnv ? createEnvApiKeyResolver() : (): undefined => undefined;
  const staticResolver = apiKeys
    ? createStaticApiKeyResolver(apiKeys)
    : (): undefined => undefined;

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
