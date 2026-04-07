# @renx/provider 使用指南（入门 → 进阶）

本文档说明如何在项目中安装、配置并使用 `packages/provider`（包名 **`@renx/provider`**）提供的 LLM 与多模态能力。

---

## 1. 包定位与入口

`@renx/provider` 提供：

- 统一的 **`createLLMClient`**：文本生成 / 流式、文生图、语音合成、语音转写、视频生成与轮询下载（具体能力取决于已注册的厂商 Adapter）。
- **厂商适配器**：OpenAI、Anthropic、MiniMax（`minimaxi`）、以及用于测试的 Echo。
- **注册表 `LLMRegistry`**：按 `vendorId` 路由请求。
- **错误类型 `LLMError`**：可区分错误码、是否可重试，并映射为对用户友好的文案（`toPublicMessage`）。

**入口（二选一）：**

| 路径 | 说明 |
|------|------|
| `@renx/provider` | 与根 `src/index.ts` 一致，默认导出 LLM 能力 |
| `@renx/provider/llm` | 显式子路径，与 `src/llm/index.ts` 对齐 |

构建产物由 `pnpm --filter @renx/provider run build`（`tsc -b`）生成到 `dist/`；在 monorepo 内开发时通常用 TypeScript 工程引用直接指向源码或 `dist`，视根 `package.json` / `tsconfig` 而定。

**在 monorepo 中依赖示例（`package.json`）：**

```json
{
  "dependencies": {
    "@renx/provider": "workspace:*"
  }
}
```

---

## 2. 入门：5 分钟跑通文本请求

### 2.1 最简写法（推荐）：`createDefaultLLMClient` + 厂商工厂

不必先手写 `registry` + `resolveApiKey`，默认已注册 **OpenAI + Anthropic**，并从环境变量读密钥：

```typescript
import { createDefaultLLMClient, openai, anthropic } from "@renx/provider";

const client = createDefaultLLMClient();

const result = await client.generateText({
  model: openai("gpt-4o-mini"),
  prompt: "用一句话介绍 TypeScript。",
  temperature: 0.7,
});

const claude = await client.generateText({
  model: anthropic("claude-sonnet-4-20250514"),
  prompt: "Hi",
});
```

`openai("...")` / `anthropic("...")` / `minimaxi("...")` 等价于字符串 **`"openai/..."`** 等，只是写法接近 `@ai-sdk/*` 的「先选厂商再选模型」。

#### 同一 `client` 下切换多个模型

**可以。** 每次请求的 `model` 都可以不同，**不需要**为每个模型再 `createDefaultLLMClient()` 一次。路由规则是：`model` 里的 **`vendor`**（`openai` / `anthropic` / `minimaxi` …）决定走哪个 Adapter；**`modelId`** 决定上游具体模型名。

前提：**当前 Client 的注册表里已包含该厂商**，且对应 Key 已配置（环境变量或 `apiKeys`）。例如要同时切 OpenAI、Anthropic、MiniMax 文本：

```typescript
import { createDefaultLLMClient, openai, anthropic, minimaxi } from "@renx/provider";

const client = createDefaultLLMClient({
  preset: "openai-anthropic-minimaxi",
});

// 不同调用、不同模型
await client.generateText({ model: openai("gpt-4o-mini"), prompt: "…" });
await client.generateText({ model: anthropic("claude-sonnet-4-20250514"), prompt: "…" });
await client.streamText({ model: minimaxi("MiniMax-M2.7"), prompt: "…" });

// 配置驱动：用户在下拉里选的值拼成 vendor/model 即可
const model = `${userVendor}/${userModelId}`;
await client.generateText({ model, prompt: "…" });
```

若只用默认 preset `openai-anthropic`，则 **`minimaxi/...` 会报未知厂商**；需要 MiniMax 时改用 `preset: "openai-anthropic-minimaxi"` 或自建 `registry`。

### 2.2 一行改 API Key、Base URL、包含 MiniMax

```typescript
const client = createDefaultLLMClient({
  apiKeys: {
    openai: "sk-...",
    anthropic: "sk-ant-...",
  },
  baseUrlByVendor: {
    openai: "https://api.openai.com/v1",
  },
  preset: "openai-anthropic-minimaxi", // 需配置 MINIMAXI_API_KEY 或 apiKeys.minimaxi
});
```

- **`preset`**：`"openai-anthropic"`（默认）| `"openai-anthropic-minimaxi"` | `"minimaxi-only"`
- **`apiKeys`**：显式值优先，未写的厂商仍可走 **`useEnv: true`（默认）** 读环境变量
- 其余字段与 `createLLMClient` 相同：`fetch`、`defaultTimeoutMs`、`hooks`、`shouldRetry` 等

### 2.3 为什么文档里还会出现「手写 registry」？和裸 `generateText` 有何不同？

- 本库是 **多厂商注册表**：一个 `client` 内可同时存在 `openai`、`anthropic`、`minimaxi`，靠 `model` 前缀路由；`createDefaultLLMClient` 只是把「常用预设 + 环境密钥」封装成默认值。
- **没有**提供无上下文的顶层 `generateText(...)`，是为了避免 **全局隐式配置**（密钥、代理、多租户、单测 mock `fetch` 难注入）。生成能力都挂在 **`client.generateText`** 上；若你已用 `createDefaultLLMClient()`，**只需多写一行 `const client = ...`**，之后调用形态与「简洁 SDK」类似。
- `@ai-sdk/anthropic` 的 `anthropic("claude-...")` 在包内已绑定厂商；这里用 **`anthropic("claude-...")` 工厂** 达到相近书写体验，底层仍是统一的 `vendor/model` 与同一套 `LLMClient`。

### 2.4 环境变量（与 `createDefaultLLMClient` 配合）

未在 `apiKeys` 里指定的厂商，默认仍用 `createEnvApiKeyResolver()` 读：

| 厂商 | 环境变量 |
|------|-----------|
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| MiniMax | `MINIMAXI_API_KEY` |

### 2.5 显式 `createLLMClient`（完全自定义注册表 / 解析器）

需要自选 Adapter 列表或自定义 `resolveApiKey` 时使用：

```typescript
import {
  createLLMClient,
  createOpenAIAndAnthropicRegistry,
  createEnvApiKeyResolver,
} from "@renx/provider";

const client = createLLMClient({
  registry: createOpenAIAndAnthropicRegistry(),
  resolveApiKey: createEnvApiKeyResolver(),
});

const result = await client.generateText({
  model: "openai/gpt-4o-mini",
  prompt: "用一句话介绍 TypeScript。",
  temperature: 0.7,
});

console.log(result.text);
console.log(result.finishReason, result.usage);
```

### 2.6 模型怎么写：`"vendor/modelId"`

字符串 **`"openai/gpt-4o-mini"`** 会被解析为：

- `vendorId`: `openai`
- `modelId`: `gpt-4o-mini`

注册表里必须已经 `register` 了对应 `vendorId` 的 Adapter（`createDefaultLLMClient()` 的默认 preset 已包含 `openai` 与 `anthropic`）。

### 2.7 流式输出 `streamText`

```typescript
const { textStream, text, finishReason, usage } = await client.streamText({
  model: "openai/gpt-4o-mini",
  prompt: "数到 5，每数一个换行。",
});

for await (const chunk of textStream) {
  if (chunk.type === "text-delta") {
    process.stdout.write(chunk.textDelta);
  }
}

console.log("\nfull:", await text);
console.log("finish:", await finishReason);
```

要点：

- 必须 **消费** `textStream`（`for await`），`text` / `finishReason` / `usage` 等 Promise 才会在流正常结束时 resolve。
- 若建连阶段失败，错误在 `await client.streamText(...)` 上抛出，而不是在 `textStream` 里（避免未处理的 Promise）。

---

## 3. 基础概念

### 3.1 `ModelHandle` 与 `modelRef`

除字符串外，也可用 **`modelRef`** 带上每调用的 `providerOptions`：

```typescript
import { modelRef } from "@renx/provider";

await client.generateText({
  model: modelRef("openai", "gpt-4o-mini", {
    providerOptions: { openai: { /* 透传到请求体的扩展字段 */ } },
  }),
  prompt: "hi",
});
```

`parseModelRefString("anthropic/claude-3-5-sonnet-20241022")` 仅解析，不注册厂商。

### 3.2 请求体：`prompt` 与 `messages`

- 只传 **`prompt`**：会变为单条 user 消息。
- 传 **`messages`**：使用多轮结构（`CanonicalMessage`：`role` + `content` 数组，文本用 `{ type: "text", text: "..." }`）。
- 二者都传时，以 **`messages`** 为准（与内部 `buildCanonicalRequest` 行为一致）。

### 3.3 常用调用选项（`ClientCallOptionsBase`）

| 字段 | 作用 |
|------|------|
| `model` | `string` 或 `ModelHandle` |
| `abortSignal` | 取消请求（与厂商 `fetch` + 内部超时信号合并） |
| `timeoutMs` | 单次调用超时（毫秒）；未设置则用 `defaultTimeoutMs` |
| `retry` | 覆盖重试策略片段，并可设 `deadlineMs` 总期限 |
| `metadata` | 仅供 `hooks` 观测，不参与上游协议 |
| `providerOptions` | 按厂商透传；如 OpenAI 常与 `openai` key 合并进 body |
| `includeRaw` | 为 `true` 时在结果中保留 `raw`（若适配器提供） |

---

## 4. 错误处理与用户可见文案

所有失败应 **`try/catch`**，用 **`LLMError.isInstance(e)`** 判断：

```typescript
import {
  LLMError,
  toPublicMessage,
  isRetryableLlmError,
} from "@renx/provider";

try {
  await client.generateText({ model: "openai/gpt-4o-mini", prompt: "x" });
} catch (e) {
  if (LLMError.isInstance(e)) {
    const userFacing = toPublicMessage(e.code); // 英文安全文案，可给前端展示
    console.error(userFacing, e.code, e.retryable);
    if (isRetryableLlmError(e)) {
      /* 可提示稍后重试 */
    }
  }
  throw e;
}
```

常见 **`LLMErrorCode`**：`UNAUTHORIZED`、`RATE_LIMIT`、`TIMEOUT`、`ABORTED`、`NOT_IMPLEMENTED`（某厂商未实现该能力）、`MODEL_NOT_FOUND`（未知 vendor）等。

---

## 5. 进阶：Client 配置

### 5.1 默认超时与重试

```typescript
const client = createLLMClient({
  registry: createOpenAIAndAnthropicRegistry(),
  resolveApiKey: createEnvApiKeyResolver(),
  defaultTimeoutMs: 60_000,
  defaultRetry: {
    maxAttempts: 5,
    initialDelayMs: 500,
    maxDelayMs: 30_000,
    backoffMultiplier: 2,
    jitterRatio: 0.2,
  },
  shouldRetry: (err) => err.retryable && err.code !== "ABORTED",
});
```

单次调用可用 **`retry: { maxAttempts: 1 }`** 关闭重试，或 **`deadlineMs`** 限制整次调用的重试窗口。

### 5.2 自定义 `fetch`（代理、单测、边缘环境）

```typescript
const client = createLLMClient({
  registry,
  resolveApiKey: ...,
  fetch: globalThis.fetch,
});
```

单测里可注入返回固定 `Response` 的 mock，无需打真实网络。

### 5.3 按厂商覆盖 Base URL

```typescript
const client = createLLMClient({
  registry,
  resolveApiKey: ...,
  baseUrlByVendor: {
    openai: "https://your-proxy.example/v1",
  },
});
```

MiniMax 适配器默认 `https://api.minimaxi.com`；也可通过同一字段覆盖。

### 5.4 Hooks（可观测性）

```typescript
const client = createLLMClient({
  registry,
  resolveApiKey: ...,
  hooks: {
    onRequestStart: ({ vendorId, modelId, mode, metadata }) => {
      /* mode: generate | stream | image | speech | transcribe | video | video_job | video_download */
    },
    onRequestEnd: ({ ok, latencyMs, error, mode, vendorId, modelId }) => {},
    onRetry: ({ attempt, error, vendorId, modelId }) => {},
    onStreamChunk: async ({ chunk }) => {},
  },
});
```

---

## 6. 多模态与视频流程

### 6.1 能力矩阵（取决于厂商）

| 方法 | OpenAI | Anthropic | MiniMax (`minimaxi`) |
|------|--------|-----------|----------------------|
| `generateText` / `streamText` | ✅ | ✅ | ✅（OpenAI 兼容端点） |
| `generateImage` | ✅ | ❌（`NOT_IMPLEMENTED`） | ✅ |
| `textToSpeech` | ✅ | ❌ | ✅ |
| `transcribe` | ✅ | ❌ | ❌（未接 STT） |
| `generateVideo` / `getVideoJob` / `downloadVideo` | ✅ | ❌ | ✅ |

### 6.2 文生图示例（OpenAI）

```typescript
const img = await client.generateImage({
  model: "openai/dall-e-3",
  prompt: "A minimal icon of a book, flat vector",
  size: "1024x1024",
  responseFormat: "url",
});
console.log(img.images[0]?.url);
```

### 6.3 语音合成（OpenAI）

```typescript
const speech = await client.textToSpeech({
  model: "openai/tts-1",
  text: "Hello from the provider package.",
  voice: "alloy",
  format: "mp3",
});
// speech.audio: Uint8Array
```

### 6.4 视频：OpenAI 与 MiniMax 的差异（重要）

**OpenAI（Videos API）**

1. `generateVideo` → 得到 **`videoId`** 与状态。  
2. `getVideoJob({ model, videoId })` 轮询状态。  
3. `downloadVideo({ model, videoId })` 拉取二进制（**必须提供 `videoId`**）。

**MiniMax**

1. `generateVideo` → 返回的 **`videoId` 实为 `task_id`**。  
2. `getVideoJob({ model, videoId: task_id })` → 成功时出现 **`fileId`**（对应上游 `file_id`）。  
3. `downloadVideo({ model, fileId })` **必须传 `fileId`**（不能只传 task id）。

通用校验：`downloadVideo` 要求 **`videoId` 与 `fileId` 至少一个**，否则会抛 `INVALID_REQUEST`。

### 6.5 MiniMax 专用预设与模型名示例

```typescript
import {
  createLLMClient,
  createMinimaxiRegistry,
  createOpenAIAnthropicAndMinimaxiRegistry,
  createEnvApiKeyResolver,
} from "@renx/provider";

// 仅 MiniMax
const miniOnly = createLLMClient({
  registry: createMinimaxiRegistry(),
  resolveApiKey: createEnvApiKeyResolver(),
});

// OpenAI + Anthropic + MiniMax
const all = createLLMClient({
  registry: createOpenAIAnthropicAndMinimaxiRegistry(),
  resolveApiKey: createEnvApiKeyResolver(),
});
```

模型字符串示例（以官方文档为准，随时可能更新）：

- 文本：`minimaxi/MiniMax-M2.7`
- 图片：`minimaxi/image-01`
- 语音：`minimaxi/speech-2.8-hd`（`voice` 或 `providerOptions.minimaxi` 可配音色等）
- 视频：`minimaxi/MiniMax-Hailuo-2.3`，`size` 常作分辨率如 `768P`，`seconds` 映射为上游 `duration`

官方文档索引：<https://platform.minimaxi.com/docs/llms.txt>

### 6.6 `providerOptions` 按厂商扩展

例如向 OpenAI 请求体合并额外字段：

```typescript
await client.generateText({
  model: "openai/gpt-4o-mini",
  prompt: "hi",
  providerOptions: {
    openai: { user: "internal-user-id" },
  },
});
```

MiniMax 图片/语音/视频同样支持 **`providerOptions.minimaxi`** 合并到 JSON body（注意与内置字段冲突时以后写为准）。

---

## 7. 注册表：组合多个厂商

### 7.1 预设

- `createOpenAIAndAnthropicRegistry()`  
- `createMinimaxiRegistry()`  
- `createOpenAIAnthropicAndMinimaxiRegistry()`

### 7.2 自定义列表

```typescript
import {
  createRegistry,
  createOpenAIAdapter,
  createEchoAdapter,
} from "@renx/provider";

const registry = createRegistry([
  createOpenAIAdapter(),
  createEchoAdapter(),
]);
```

`createRegistry` 内若重复 `vendorId` 且未 `overwrite`，会抛错。

### 7.3 静态密钥（不适合提交到仓库）

```typescript
import { createStaticApiKeyResolver } from "@renx/provider";

const resolveApiKey = createStaticApiKeyResolver({
  openai: process.env.OPENAI_API_KEY!,
  anthropic: "sk-ant-...",
  minimaxi: process.env.MINIMAXI_API_KEY!,
});
```

---

## 8. 进阶：实现自定义 `LLMAdapter`

若你要接入新厂商：

1. 实现 **`LLMAdapter`**（见 `AdapterInvokeContext`、`CanonicalRequest`、流式 chunk 类型等）。  
2. 文本必填：`generateText`、`streamText`、`getCapabilities`、`mapError`。  
3. 多模态按需实现可选方法：`generateImage`、`textToSpeech`、`transcribe`、`generateVideo`、`getVideoJob`、`downloadVideo`。  
4. 用 **`createRegistry([yourAdapter])`** 注册，再走 **`createLLMClient`**。

未实现的方法在 Client 上会收到 **`NOT_IMPLEMENTED`**。

---

## 9. 测试与 Echo Adapter

本地或 CI 不调用外网时，可使用 **`createEchoAdapter()`**（`vendorId: "echo"`）：

- 文本会回显 `echo:${内容}`。  
- 多模态返回占位数据，便于跑通 Client 与注册表逻辑。

```typescript
import { createEchoAdapter, createRegistry, createLLMClient } from "@renx/provider";

const client = createLLMClient({
  registry: createRegistry([createEchoAdapter()]),
  resolveApiKey: () => "test",
});

await client.generateText({ model: "echo/any", prompt: "hi" });
```

---

## 10. 构建与类型

在包目录执行：

```bash
pnpm run build
```

确保消费方 `moduleResolution` 与 ESM 设置能解析 `exports` 字段（如 `"bundler"` + `"ESNext"`）。

---

## 11. 常见问题（FAQ）

**Q：`MODEL_NOT_FOUND` / Unknown vendor**  
A：`model` 前缀的厂商未在 `registry` 中注册，或拼写与 Adapter 的 `vendorId` 不一致（OpenAI 为 `openai`，MiniMax 为 `minimaxi`）。

**Q：流式很慢或一直不结束**  
A：确认消费了 `textStream`；检查上游是否真正关闭连接；可适当设置 `timeoutMs`。

**Q：MiniMax 下载视频失败**  
A：确认 `getVideoJob` 状态已为 **`completed`**（映射后），且使用返回的 **`fileId`** 调用 `downloadVideo`，而不是仅用 `task_id`。

**Q：想改重试条件**  
A：使用 `shouldRetry` 或单次调用的 `retry.maxAttempts` / `deadlineMs`。

---

## 12. 参考链接

- MiniMax 开放平台文档索引：<https://platform.minimaxi.com/docs/llms.txt>  
- 本仓库企业规格（若存在）：`docs/llm-provider-enterprise-spec.md`

---

*文档版本与 `@renx/provider` 源码同步维护；若 API 变更，请以 `packages/provider/src/llm` 下类型与导出为准。*
