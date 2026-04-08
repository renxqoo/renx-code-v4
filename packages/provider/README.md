# @renx/provider

多厂商 LLM 与多模态（文本、图像、语音、视频等）统一客户端，基于注册表与可插拔 Adapter。支持 **Functional API**（直接 `import { generateText } from "@renx/provider"` 调用）和 **Client API**（`createLLMClient` / `createDefaultLLMClient`）。对话侧图文统一为 **`MessagePart`**（`generateText` / `streamText` 的 **`messages`** 或 **`prompt: string | MessagePart[]`**），详见使用指南。

## 文档

- **[使用指南（入门 → 进阶）](./docs/USAGE.md)** — 安装、环境变量、`createLLMClient`、多模态、MiniMax、错误处理、自定义 Adapter 等

## 入口

- 主入口：`@renx/provider`（`src/index.ts` → `src/llm`）
- 显式子路径：`@renx/provider/llm`

## 脚本

```bash
pnpm run build          # tsc -b → dist/
pnpm run test:coverage  # vitest + coverage
```

在仓库根目录也可：`pnpm --filter @renx/provider run build`

## 目录结构（摘要）

```
src/
  index.ts              # 导出 LLM 公共 API
  llm/
    client.ts           # createLLMClient
    functional.ts       # Functional API（generateText / streamText 等）
    adapters/           # openai、anthropic、echo
    minimax/            # MiniMax 厂商（adapter、credentials、测试）
    registry.ts
    presets.ts          # 内置厂商注册表工厂
    credentials.ts      # API Key 解析
    …
docs/
  USAGE.md              # 详细使用说明
```

## 快速示例

```typescript
import { generateText, openai } from "@renx/provider";

// 直接调用，无需创建 Client（底层自动维护单例）
const { text } = await generateText({
  model: openai("gpt-4o-mini"),
  prompt: "Hello",
});
```

如需显式创建 Client 或自定义配置，可使用 `createDefaultLLMClient` 或 `createLLMClient`：

```typescript
import { createDefaultLLMClient, openai } from "@renx/provider";

const client = createDefaultLLMClient();
const { text } = await client.generateText({
  model: openai("gpt-4o-mini"),
  prompt: "Hello",
});
```

更多多厂商组合方式、**对话多模态（Vision）**、`buildCanonicalRequest` 与 **`message-parts`** 辅助函数见 [docs/USAGE.md](./docs/USAGE.md)。
