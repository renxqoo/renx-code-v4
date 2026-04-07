# @renx/provider

多厂商 LLM 与多模态（文本、图像、语音、视频等）统一客户端，基于注册表与可插拔 Adapter。

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
    adapters/           # openai、anthropic、echo
    minimaxi/           # MiniMax 厂商（adapter、credentials、测试）
    registry.ts
    presets.ts          # 预设注册表组合
    credentials.ts      # API Key 解析
    …
docs/
  USAGE.md              # 详细使用说明
```

## 快速示例

```typescript
import { createDefaultLLMClient, openai } from "@renx/provider";

const client = createDefaultLLMClient();

const { text } = await client.generateText({
  model: openai("gpt-4o-mini"),
  prompt: "Hello",
});
```

更多预设（仅 MiniMax、三厂商合并等）与多模态用法见 [docs/USAGE.md](./docs/USAGE.md)。
