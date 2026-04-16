# @renx/provider 使用指南（入门 → 进阶）

本文档说明如何在项目中安装、配置并使用 `packages/provider`（包名 **`@renx/provider`**）提供的 LLM 与多模态能力。

---

## 1. 包定位与入口

`@renx/provider` 提供：

- **Functional API**：`generateText`、`streamText` 等顶层函数，直接 import 即可调用，底层自动维护懒加载单例 Client。
- 统一的 **`createLLMClient`**：文本生成 / 流式、文生图、语音合成、语音转写、视频生成与轮询下载（具体能力取决于已注册的厂商 Adapter）。
- **厂商适配器**：OpenAI、Anthropic、MiniMax（`minimax`）、以及用于测试的 Echo。
- **注册表 `LLMRegistry`**：按 `vendorId` 路由请求。
- **错误类型 `LLMError`**：可区分错误码、是否可重试，并映射为对用户友好的文案（`toPublicMessage`）。

**入口（二选一）：**

| 路径                 | 说明                                        |
| -------------------- | ------------------------------------------- |
| `@renx/provider`     | 与根 `src/index.ts` 一致，默认导出 LLM 能力 |
| `@renx/provider/llm` | 显式子路径，与 `src/llm/index.ts` 对齐      |

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

不必先手写 `registry` + `resolveApiKey`，默认已注册 **OpenAI + Anthropic + MiniMax**，并从环境变量读密钥：

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

`openai("...")` / `anthropic("...")` / `minimax("...")` 等价于字符串 **`"openai/..."`** 等，只是写法接近 `@ai-sdk/*` 的「先选厂商再选模型」。

#### 同一 `client` 下切换多个模型

**可以。** 每次请求的 `model` 都可以不同，**不需要**为每个模型再 `createDefaultLLMClient()` 一次。路由规则是：`model` 里的 **`vendor`**（`openai` / `anthropic` / `minimax` …）决定走哪个 Adapter；**`modelId`** 决定上游具体模型名。

前提：**当前 Client 的注册表里已包含该厂商**，且对应 Key 已配置（环境变量或 `apiKeys`）。例如要同时切 OpenAI、Anthropic、MiniMax 文本：

```typescript
import { createDefaultLLMClient, openai, anthropic, minimax } from "@renx/provider";

const client = createDefaultLLMClient({
  vendors: ["openai", "anthropic", "minimax"],
});

// 不同调用、不同模型
await client.generateText({ model: openai("gpt-4o-mini"), prompt: "…" });
await client.generateText({ model: anthropic("claude-sonnet-4-20250514"), prompt: "…" });
await client.streamText({ model: minimax("MiniMax-M2.7"), prompt: "…" });

// 配置驱动：用户在下拉里选的值拼成 vendor/model 即可
const model = `${userVendor}/${userModelId}`;
await client.generateText({ model, prompt: "…" });
```

若只注册 `["openai", "anthropic"]`，则 **`minimax/...` 会报未知厂商**；需要 MiniMax 时改用 `vendors: ["openai", "anthropic", "minimax"]` 或自建 `registry`。

### 2.2 一行改 API Key、Base URL、包含 MiniMax

```typescript
const client = createDefaultLLMClient({
  apiKeys: {
    openai: "sk-...",
    anthropic: "sk-ant-...",
    minimax: "mx-...",
  },
  baseUrlByVendor: {
    openai: "https://api.openai.com/v1",
  },
  vendors: ["openai", "anthropic", "minimax"],
});
```

- **`vendors`**：要注册的内置厂商列表，默认 `["openai", "anthropic", "minimax"]`
- **`apiKeys`**：显式值优先，未写的厂商仍可走 **`useEnv: true`（默认）** 读环境变量
- 其余字段与 `createLLMClient` 相同：`fetch`、`defaultTimeoutMs`、`hooks`、`shouldRetry` 等

### 2.3 Functional API（直接调用，无需创建 Client）

如果不需要多租户、自定义 `fetch` 或细粒度 `hooks`，可以直接 import 函数式 API —— 底层自动维护一个 **懒加载单例 Client**：

```typescript
import { generateText, streamText, openai, anthropic } from "@renx/provider";

// 首次调用时自动创建默认 Client，之后复用同一实例
const { text } = await generateText({
  model: openai("gpt-4o-mini"),
  prompt: "Hello",
});

// 流式同理
const { textStream, text: fullText } = await streamText({
  model: anthropic("claude-sonnet-4-20250514"),
  prompt: "Hi",
});
for await (const chunk of textStream) {
  if (chunk.type === "text-delta") process.stdout.write(chunk.textDelta);
}
```

**可用的函数式 API：**

| 函数                                     | 说明                 |
| ---------------------------------------- | -------------------- |
| `generateText(options, clientOptions?)`  | 文本生成             |
| `streamText(options, clientOptions?)`    | 流式文本生成         |
| `generateImage(options, clientOptions?)` | 文生图               |
| `textToSpeech(options, clientOptions?)`  | 语音合成             |
| `transcribe(options, clientOptions?)`    | 语音转写             |
| `generateVideo(options, clientOptions?)` | 视频生成（异步任务） |
| `getVideoJob(options, clientOptions?)`   | 查询视频任务状态     |
| `downloadVideo(options, clientOptions?)` | 下载视频内容         |

第二个参数 `clientOptions` 可选，仅在 **首次调用** 时生效（控制默认 Client 的初始化配置），与 `createDefaultLLMClient` 的参数一致：

```typescript
import { generateText } from "@renx/provider";

await generateText(
  { model: "openai/gpt-4o-mini", prompt: "hi" },
  {
    apiKeys: { openai: "sk-..." },
    vendors: ["openai", "anthropic", "minimax"],
    baseUrlByVendor: { openai: "https://your-proxy/v1" },
  },
);
```

**重置单例**（单测、配置热更新等场景）：

```typescript
import { resetDefaultClient } from "@renx/provider";

resetDefaultClient(); // 下次调用 generateText 等函数时重新初始化
```

**何时用 Functional API，何时用 Client？**

- **Functional API**：脚本、原型、简单应用 —— 零配置、调用最简
- **`createLLMClient`**：多租户、注入自定义 `fetch`（单测/代理）、细粒度 `hooks`、不同请求用不同密钥
- **`createDefaultLLMClient`**：想共享配置但需显式持有 Client 实例

### 2.4 为什么文档里还会出现「手写 registry」？

- 本库是 **多厂商注册表**：一个 `client` 内可同时存在 `openai`、`anthropic`、`minimax`，靠 `model` 前缀路由；`createDefaultLLMClient` 只是把「常用厂商列表 + 环境密钥」封装成默认值。
- Functional API 底层就是 `createDefaultLLMClient()` 创建的懒加载单例；若需完全自定义（多实例、注入 fetch、自定义 hooks），请用 `createLLMClient`。
- `@ai-sdk/anthropic` 的 `anthropic("claude-...")` 在包内已绑定厂商；这里用 **`anthropic("claude-...")` 工厂** 达到相近书写体验，底层仍是统一的 `vendor/model` 与同一套 `LLMClient`。

### 2.5 环境变量（与 `createDefaultLLMClient` 配合）

未在 `apiKeys` 里指定的厂商，默认仍用 `createEnvApiKeyResolver()` 读：

| 厂商      | 环境变量            |
| --------- | ------------------- |
| OpenAI    | `OPENAI_API_KEY`    |
| Anthropic | `ANTHROPIC_API_KEY` |
| MiniMax   | `MINIMAX_API_KEY`   |

### 2.6 显式 `createLLMClient`（完全自定义注册表 / 解析器）

需要自选 Adapter 列表或自定义 `resolveApiKey` 时使用：

```typescript
import {
  createLLMClient,
  createRegistryForVendors,
  createEnvApiKeyResolver,
} from "@renx/provider";

const client = createLLMClient({
  registry: createRegistryForVendors(["openai", "anthropic"]),
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

### 2.7 模型怎么写：`"vendor/modelId"`

字符串 **`"openai/gpt-4o-mini"`** 会被解析为：

- `vendorId`: `openai`
- `modelId`: `gpt-4o-mini`

注册表里必须已经 `register` 了对应 `vendorId` 的 Adapter（`createDefaultLLMClient()` 默认已包含 `openai`、`anthropic` 与 `minimax`）。

### 2.8 流式输出 `streamText`

```typescript
const { textStream, text, reasoning, toolCalls, finishReason, usage } = await client.streamText({
  model: "openai/gpt-4o-mini",
  prompt: "数到 5，每数一个换行。",
});

for await (const chunk of textStream) {
  switch (chunk.type) {
    case "text-delta":
      process.stdout.write(chunk.textDelta);
      break;
    case "reasoning-delta":
      // 思考/推理内容（需要上游支持，如 MiniMax reasoning_split）
      process.stdout.write(chunk.reasoningDelta);
      break;
    case "tool-call-delta":
      // 工具调用增量
      if (chunk.name) console.log(`[tool: ${chunk.name}]`);
      if (chunk.argumentsDelta) process.stdout.write(chunk.argumentsDelta);
      break;
  }
}

console.log("\nfull:", await text);
console.log("reasoning:", await reasoning); // 完整推理文本
console.log("toolCalls:", await toolCalls); // CanonicalToolCall[]
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
    providerOptions: { seed: 42 },
  }),
  prompt: "hi",
});
```

`parseModelRefString("anthropic/claude-3-5-sonnet-20241022")` 仅解析，不注册厂商。

### 3.2 `providerOptions`（厂商扩展参数）

`providerOptions` 用于将厂商专有字段直接合并到上游请求体。传入的键值对会被**平铺合并**到 JSON body；如果与 SDK 内置协议字段冲突，会抛出 `INVALID_REQUEST`，避免静默覆盖 `model`、`messages`、`stream` 等关键字段。

```typescript
// 所有键值对直接合并到请求体
await client.generateText({
  model: openai("gpt-4o-mini"),
  prompt: "hi",
  providerOptions: {
    seed: 42,
    user: "user-123",
  },
});
// 实际请求体: { model: "gpt-4o-mini", messages: [...], seed: 42, user: "user-123" }

// MiniMax: 直接传 reasoning_split
await client.streamText({
  model: minimax("MiniMax-M2.7"),
  prompt: "思考题",
  providerOptions: {
    reasoning_split: true,
  },
});
```

如果需要跨厂商复用同一份 `providerOptions`，可用 **厂商命名空间 key** 指定目标：

```typescript
// 只有当 vendorId === "openai" 时，seed 字段才会被提取到请求体
providerOptions: {
  openai: { seed: 42 },
  minimax: { reasoning_split: true },
}
```

SDK 会根据当前 `model` 的 `vendorId` 自动提取对应命名空间内的参数；对自定义 Adapter，若命名空间 key 与当前 `vendorId` 相同，也会按同样规则提取。未在命名空间内的键值对直接透传。

### 3.3 请求体：`prompt`、`messages` 与 `MessagePart`

对话内容统一用 **`MessagePart`** 表示；**`CanonicalMessage`** 为 `{ role, content: MessagePart[] }`，其中 **`role`** 为 `system` | `user` | `assistant` | `tool`。

**文本段（`TextPart`）**

```typescript
{ type: "text", text: string }
```

**图片段（`ImagePart`，任选一种）**

- **URL**：`{ type: "image_url", url: string, detail?: "auto" | "low" | "high" }`（`detail` 主要对应 OpenAI，会按上游语义透传）
- **Base64**：`{ type: "image_base64", mediaType: string, data: string }`（适配器会转为各厂商需要的 data URL 或 base64 块）

**工具调用段（`ToolCallPart`）** — 用于多轮对话中传递 assistant 的工具调用记录

```typescript
{ type: "tool_call", id: string, name: string, arguments: string }
```

**工具结果段（`ToolResultPart`）** — 用于多轮对话中传递工具执行结果（`role: "tool"` 消息中）

```typescript
{ type: "tool_result", toolCallId: string, content: string }
```

**`prompt`（仅 `generateText` / `streamText`）**

- **`string`**：等价于一条 user 消息，内容为 `[{ type: "text", text: prompt }]`。
- **`MessagePart[]`**：等价于一条 user 消息，内容为该数组（可图文混排）。**不得传空数组**，否则会抛出 **`INVALID_REQUEST`**。

**`messages`**

- 多轮对话时使用；与 **`prompt` 同时传入**时，以 **`messages`** 为准（与内部 **`buildCanonicalRequest`** 一致）。

**`systemPrompt`（快捷方式）**

- 传入字符串后，会在 `messages` / `prompt` 生成的消息前 **自动插入一条 system 消息**，无需手动构建 `messages` 数组。
- 与 `messages` 同时传入时，`systemPrompt` 的 system 消息插入到 `messages` 最前面。

```typescript
// 等价于 messages: [{ role: "system", content: [...] }, { role: "user", content: [...] }]
await client.generateText({
  model: openai("gpt-4o-mini"),
  prompt: "帮我翻译以下内容",
  systemPrompt: "你是一个专业翻译，只输出译文，不要解释。",
});
```

**各厂商行为摘要**

| 场景                                               | 说明                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **OpenAI**、**MiniMax**（文本走 OpenAI 兼容 Chat） | 将 `MessagePart` 映射为上游 `content` 的 parts 数组（纯文本同样以 parts 形式发送）。                         |
| **Anthropic**                                      | user 可为多块（文本 + 图）；**system** 与 **assistant** 消息中**不能含图片**，否则会 **`INVALID_REQUEST`**。 |
| **Echo**                                           | 图片在回显中变为 **`[image:url:…]`** / **`[image:base64:…]`** 占位，便于本地与单测。                         |

文生图、转写、视频等 API 的 **`prompt` / `text`** 仍为**字符串**（上游协议不是聊天 `content` 块）；**对话类**能力才使用上述 `MessagePart` 模型。

若还需各厂商专有字段，可通过 **`providerOptions`** 平铺合并进请求体（详见 3.2 节）。

### 3.4 常用调用选项（`ClientCallOptionsBase`）

| 字段              | 作用                                                                         |
| ----------------- | ---------------------------------------------------------------------------- |
| `model`           | `string` 或 `ModelHandle`                                                    |
| `abortSignal`     | 取消请求（与厂商 `fetch` + 内部超时信号合并；`streamText` 在建连后继续消费时也生效） |
| `timeoutMs`       | 单次调用超时（毫秒）；`streamText` 建连时生效，建连后转为空闲超时，持续有 chunk 则不会因总耗时超时 |
| `retry`           | 覆盖重试策略片段，并可设 `deadlineMs` 总期限                                 |
| `metadata`        | 仅供 `hooks` 观测，不参与上游协议                                            |
| `providerOptions` | 平铺合并到请求体；也可用厂商命名空间 key 指定目标厂商（详见 3.2 节）         |
| `includeRaw`      | 为 `true` 时在结果中保留 `raw`（若适配器提供）                               |
| `tools`           | 工具定义数组 `CanonicalTool[]`                                               |
| `toolChoice`      | `"auto"` \| `"none"` \| `"required"` \| `{ type: "function", name: string }` |

---

## 4. 错误处理与用户可见文案

所有失败应 **`try/catch`**，用 **`LLMError.isInstance(e)`** 判断：

```typescript
import { LLMError, toPublicMessage, isRetryableLlmError } from "@renx/provider";

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

库默认 **`maxAttempts: 1`（不重试）**。需要自动重试时在 Client 上配置 **`defaultRetry`**，或在单次调用时传 **`retry`**。

```typescript
const client = createLLMClient({
  registry: createRegistryForVendors(["openai", "anthropic"]),
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

单次调用可用 **`retry`** 覆盖默认策略，或 **`deadlineMs`** 限制整次调用的重试窗口。

### 5.2 `strictParams`

当 `strictParams: true` 时，Client 会在请求发送前校验当前模型能力，例如不支持 `topP` / `stopSequences` 的 Adapter 会直接抛 `INVALID_REQUEST`，避免把无效参数静默传给上游。

```typescript
const client = createLLMClient({
  registry: createRegistryForVendors(["openai", "anthropic"]),
  resolveApiKey: createEnvApiKeyResolver(),
  strictParams: true,
});
```

### 5.3 自定义 `fetch`（代理、单测、边缘环境）

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

| 方法                                              | OpenAI | Anthropic               | MiniMax (`minimax`)   |
| ------------------------------------------------- | ------ | ----------------------- | --------------------- |
| `generateText` / `streamText`                     | ✅     | ✅                      | ✅（OpenAI 兼容端点） |
| `generateImage`                                   | ✅     | ❌（`NOT_IMPLEMENTED`） | ✅                    |
| `textToSpeech`                                    | ✅     | ❌                      | ✅                    |
| `transcribe`                                      | ✅     | ❌                      | ❌（未接 STT）        |
| `generateVideo` / `getVideoJob` / `downloadVideo` | ✅     | ❌                      | ✅                    |

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

- 文本：`minimax/MiniMax-M2.7`
- 图片：`minimax/image-01`
- 语音：`minimax/speech-2.8-hd`（`voice` 或 `providerOptions` 可配音色等）
- 视频：`minimax/MiniMax-Hailuo-2.3`，`size` 常作分辨率如 `768P`，`seconds` 映射为上游 `duration`

官方文档索引：<https://platform.minimaxi.com/docs/llms.txt>

### 6.6 `providerOptions` 按厂商扩展

向请求体合并额外字段（详见 3.2 节）：

```typescript
await client.generateText({
  model: "openai/gpt-4o-mini",
  prompt: "hi",
  providerOptions: {
    user: "internal-user-id",
    seed: 42,
  },
});
```

MiniMax 图片/语音/视频同样支持 `providerOptions` 合并到 JSON body；若与内置字段冲突，会抛出 `INVALID_REQUEST`。

### 6.7 对话多模态（文本 + 图片）

单轮可直接用 **`prompt` 传 `MessagePart[]`**；需要 **system** 或多轮时用 **`messages`**。

```typescript
// 单轮：图文 prompt
await client.generateText({
  model: openai("gpt-4o"),
  prompt: [
    { type: "text", text: "这张图片里主要是什么？" },
    { type: "image_url", url: "https://example.com/photo.jpg" },
  ],
});

// 多轮或带 system：与 prompt 同一套 content 结构
await client.generateText({
  model: anthropic("claude-sonnet-4-20250514"),
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "请描述附图" },
        { type: "image_url", url: "https://example.com/screenshot.png" },
      ],
    },
  ],
});
```

本地或内网图片可用 **`image_base64`**（`mediaType` 如 `image/png`、`image/jpeg`）：

```typescript
await client.generateText({
  model: openai("gpt-4o"),
  prompt: [
    { type: "text", text: "读图" },
    { type: "image_base64", mediaType: "image/png", data: "<base64 不含前缀>" },
  ],
});
```

---

## 7. 工具调用（Tool / Function Calling）

SDK 支持 OpenAI/MiniMax 格式的工具调用（Phase 1），包括非流式和流式场景。

### 7.1 定义工具

```typescript
import type { CanonicalTool } from "@renx/provider";

const tools: CanonicalTool[] = [
  {
    name: "get_weather",
    description: "Get the current weather in a city",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name" },
      },
      required: ["city"],
    },
  },
];
```

### 7.2 非流式工具调用

```typescript
const result = await client.generateText({
  model: openai("gpt-4o-mini"),
  prompt: "What's the weather in Tokyo?",
  tools,
  toolChoice: "auto",
});

// result.finishReason === "tool_calls" 表示模型选择了调用工具
if (result.toolCalls && result.toolCalls.length > 0) {
  for (const tc of result.toolCalls) {
    console.log(`Tool: ${tc.name}, Args: ${tc.arguments}, ID: ${tc.id}`);
  }
}
```

**`toolChoice` 选项：**

| 值                                  | 含义                     |
| ----------------------------------- | ------------------------ |
| `"auto"`（默认）                    | 模型自行决定是否调用工具 |
| `"none"`                            | 禁止工具调用             |
| `"required"`                        | 必须调用至少一个工具     |
| `{ type: "function", name: "..." }` | 强制调用指定函数         |

### 7.3 流式工具调用

流式模式下，工具调用以 `tool-call-delta` 增量 chunk 到达；流结束后 `toolCalls` Promise 汇总完整调用列表：

```typescript
const { textStream, text, toolCalls, finishReason } = await client.streamText({
  model: openai("gpt-4o-mini"),
  prompt: "Search for TypeScript 5.0 release notes.",
  tools,
});

for await (const chunk of textStream) {
  if (chunk.type === "text-delta") {
    process.stdout.write(chunk.textDelta);
  }
  if (chunk.type === "tool-call-delta") {
    // chunk.id, chunk.name 只在首次 chunk 中出现
    // chunk.argumentsDelta 为参数增量片段
  }
}

const calls = await toolCalls; // CanonicalToolCall[]
console.log("Tool calls:", calls);
```

**`ToolCallDeltaChunk` 结构：**

| 字段             | 类型                | 说明                                   |
| ---------------- | ------------------- | -------------------------------------- |
| `type`           | `"tool-call-delta"` | 固定值                                 |
| `index`          | `number`            | 工具调用在列表中的索引（支持并行调用） |
| `id`             | `string?`           | 仅首次 chunk 携带                      |
| `name`           | `string?`           | 仅首次 chunk 携带                      |
| `argumentsDelta` | `string?`           | 参数片段，需拼接                       |

### 7.4 多轮工具调用（Round-Trip）

完整的工具调用流程为：**发送工具定义 → 模型返回 tool_calls → 执行工具 → 将结果追加到 messages → 再次请求**：

```typescript
import type { CanonicalMessage } from "@renx/provider";

const messages: CanonicalMessage[] = [
  { role: "user", content: [{ type: "text", text: "Beijing weather?" }] },
];

// 第 1 轮：模型返回 tool_calls
const r1 = await client.generateText({ model: openai("gpt-4o"), messages, tools });

if (r1.toolCalls) {
  // 追加 assistant 的 tool_call 消息
  messages.push({
    role: "assistant",
    content: r1.toolCalls.map((tc) => ({
      type: "tool_call",
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    })),
  });

  // 执行工具并追加 tool result 消息
  for (const tc of r1.toolCalls) {
    const result = executeMyTool(tc.name, JSON.parse(tc.arguments));
    messages.push({
      role: "tool",
      content: [{ type: "tool_result", toolCallId: tc.id, content: result }],
    });
  }

  // 第 2 轮：模型基于工具结果生成最终回复
  const r2 = await client.generateText({ model: openai("gpt-4o"), messages, tools });
  console.log(r2.text);
}
```

### 7.5 相关类型导出

| 类型                 | 说明                                            |
| -------------------- | ----------------------------------------------- |
| `CanonicalTool`      | 工具定义：`{ name, description?, parameters? }` |
| `CanonicalToolCall`  | 工具调用结果：`{ id, name, arguments }`         |
| `ToolCallPart`       | 消息中的工具调用段                              |
| `ToolResultPart`     | 消息中的工具结果段                              |
| `ToolCallDeltaChunk` | 流式工具调用增量                                |
| `ToolChoice`         | 工具选择策略                                    |

---

## 8. 推理 / 思考内容（Reasoning）

部分模型（如 MiniMax M2.7 开启 `reasoning_split`、OpenAI o 系列）会在回复正文中附带推理过程。SDK 通过 `reasoning-delta` 流式 chunk 和 `reasoning` Promise 暴露这些内容。

### 8.1 流式接收推理内容

```typescript
const { textStream, text, reasoning } = await client.streamText({
  model: minimax("MiniMax-M2.7"),
  prompt: "解一道数学题",
  providerOptions: { reasoning_split: true },
});

for await (const chunk of textStream) {
  if (chunk.type === "text-delta") {
    process.stdout.write(chunk.textDelta); // 正文
  }
  if (chunk.type === "reasoning-delta") {
    process.stdout.write(chunk.reasoningDelta); // 思考过程
  }
}

console.log("思考:", await reasoning); // 完整推理文本
console.log("回答:", await text); // 完整正文
```

**`ReasoningDeltaChunk` 结构：**

| 字段             | 类型                | 说明         |
| ---------------- | ------------------- | ------------ |
| `type`           | `"reasoning-delta"` | 固定值       |
| `reasoningDelta` | `string`            | 推理文本片段 |

### 8.2 `reasoning` Promise

`StreamTextResult.reasoning` 是一个 `Promise<string>`，在流正常结束后 resolve 为完整推理文本。若模型未输出推理内容，resolve 为空字符串 `""`。

---

## 9. 注册表：组合多个厂商

### 9.1 内置厂商列表

- `createRegistryForVendors(["openai"])`
- `createRegistryForVendors(["openai", "anthropic"])`
- `createRegistryForVendors(["openai", "anthropic", "minimax"])`

### 9.2 自定义列表

```typescript
import { createRegistry, createOpenAIAdapter, createEchoAdapter } from "@renx/provider";

const registry = createRegistry([createOpenAIAdapter(), createEchoAdapter()]);
```

`createRegistry` 内若重复 `vendorId` 且未 `overwrite`，会抛错。

### 9.3 静态密钥（不适合提交到仓库）

```typescript
import { createStaticApiKeyResolver } from "@renx/provider";

const resolveApiKey = createStaticApiKeyResolver({
  openai: process.env.OPENAI_API_KEY!,
  anthropic: "sk-ant-...",
  minimax: process.env.MINIMAX_API_KEY!,
});
```

---

## 10. 进阶：实现自定义 `LLMAdapter`

若你要接入新厂商：

1. 实现 **`LLMAdapter`**（见 `AdapterInvokeContext`、`CanonicalRequest`、流式 chunk 类型等）。
2. 文本必填：`generateText`、`streamText`、`getCapabilities`、`mapError`。
3. 多模态按需实现可选方法：`generateImage`、`textToSpeech`、`transcribe`、`generateVideo`、`getVideoJob`、`downloadVideo`。
4. 用 **`createRegistry([yourAdapter])`** 注册，再走 **`createLLMClient`**。

未实现的方法在 Client 上会收到 **`NOT_IMPLEMENTED`**。

### 10.1 与 Client 对齐的请求构建与映射

以下符号由 **`@renx/provider`** 导出，自定义 Adapter 或中间层可直接复用，避免与内置 OpenAI / Anthropic / Echo 行为分叉：

| 导出                                                          | 用途                                                                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **`buildCanonicalRequest`**、**`BuildCanonicalRequestInput`** | 将 `prompt` / `messages` 等选项合并为 **`CanonicalRequest`**（与 `createLLMClient` 内部一致）。 |
| **`openAIContentForMessage`**                                 | 将 **`MessagePart[]`** 转为 OpenAI Chat Completions 的 **`content` parts 数组**。               |
| **`anthropicContentBlocks`**                                  | 将 **`MessagePart[]`** 转为 Anthropic Messages API 的 **content block 数组**。                  |
| **`flattenTextParts`**                                        | 仅文本段拼接为字符串（例如 system 提取）。                                                      |
| **`hasNonTextPart`**                                          | 判断消息中是否含非文本段（如校验 assistant 是否含图）。                                         |
| **`flattenMessagePartsForEcho`**                              | Echo 式占位回显（与内置 Echo Adapter 一致）。                                                   |

类型 **`MessagePart`**、**`TextPart`**、**`ImagePart`**、**`ToolCallPart`**、**`ToolResultPart`**、**`CanonicalMessage`** 见包内 **`types`** 导出。

---

## 11. 测试与 Echo Adapter

本地或 CI 不调用外网时，可使用 **`createEchoAdapter()`**（`vendorId: "echo"`）：

- 文本会回显 **`echo:`** 前缀加上拼好的字符串。
- 用户消息里的 **图片段**会变成 **`[image:url:…]`** / **`[image:base64:…]`** 插入该字符串。
- 其它多模态能力（文生图、语音等）返回占位数据，便于跑通 Client 与注册表逻辑。

```typescript
import { createEchoAdapter, createRegistry, createLLMClient } from "@renx/provider";

const client = createLLMClient({
  registry: createRegistry([createEchoAdapter()]),
  resolveApiKey: () => "test",
});

await client.generateText({ model: "echo/any", prompt: "hi" });
```

---

## 12. 构建与类型

在包目录执行：

```bash
pnpm run build
```

确保消费方 `moduleResolution` 与 ESM 设置能解析 `exports` 字段（如 `"bundler"` + `"ESNext"`）。

---

## 13. 常见问题（FAQ）

**Q：`MODEL_NOT_FOUND` / Unknown vendor**  
A：`model` 前缀的厂商未在 `registry` 中注册，或拼写与 Adapter 的 `vendorId` 不一致（OpenAI 为 `openai`，MiniMax 为 `minimax`）。

**Q：流式很慢或一直不结束**  
A：确认消费了 `textStream`；检查上游是否真正关闭连接；可设置 `timeoutMs` 作为建连超时与流式空闲超时。若上游持续输出 chunk，即使总耗时超过 `timeoutMs` 也不会被判超时。

**Q：MiniMax 下载视频失败**  
A：确认 `getVideoJob` 状态已为 **`completed`**（映射后），且使用返回的 **`fileId`** 调用 `downloadVideo`，而不是仅用 `task_id`。

**Q：想改重试条件**  
A：使用 `shouldRetry` 或单次调用的 `retry.maxAttempts` / `deadlineMs`。

---

## 14. 参考链接

- MiniMax 开放平台文档索引：<https://platform.minimaxi.com/docs/llms.txt>
- 本仓库企业规格（若存在）：`docs/llm-provider-enterprise-spec.md`

---

_文档版本与 `@renx/provider` 源码同步维护；若 API 变更，请以 `packages/provider/src/llm` 下类型与导出为准。_
