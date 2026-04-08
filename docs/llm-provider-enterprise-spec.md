# LLM Provider 企业级实现规格

本文档定义 `@renx/provider`（及配套 Adapter 包）的**生产可用**目标、架构、API 契约、非功能需求与交付清单。实现与代码评审应以本文档为验收基准。

**版本**：1.1  
**状态**：规格（Specification）— **V1 完整企业级 SDK**  
**读者**：实现者、SRE、安全评审、调用方业务团队

本文档描述的是 **可直接用于生产的完整 SDK（非 MVP）**：核心调度、错误与重试、可观测钩子、OpenAI / Anthropic 官方兼容 HTTP 适配器、注册表与类型导出均在 V1 交付范围内。后续版本仅叠加能力（工具调用、多模态等），不降低 V1 已承诺的可靠性语义。

---

## 1. 文档控制

| 项       | 说明                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------- |
| 变更流程 | 破坏性变更须 bump 主版本或提供迁移指南与兼容层                                                  |
| 术语     | **Canonical**：对内统一模型；**Native**：厂商原始请求/响应                                      |
| 范围     | V1：**文本对话**（非流 + SSE 流）；工具调用、多模态、结构化输出在 v2 扩展，**类型与钩子须预留** |

---

## 1.1 V1 完整企业级 SDK 模块交付范围（强制）

| 模块      | 交付物                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------ |
| 核心      | `createLLMClient`、`generateText`、`streamText`、`LLMRegistry`、`modelRef` / 字符串 `vendor/model`           |
| Canonical | 消息 parts、生成参数、`finishReason`、`usage`、流式 chunk 类型                                               |
| 错误      | `LLMError`、`RetryableError`、稳定 `code`、`toPublicMessage`、厂商错误映射（OpenAI / Anthropic）             |
| 重试      | `maxAttempts`、指数退避 + jitter、`shouldRetry` 覆盖、`AbortSignal`、单次 `timeoutMs`、可选整次 `deadlineMs` |
| 流式语义  | 重试仅覆盖「建立流式连接 / 拿到 body 之前」；连接建立后中途失败不重试                                        |
| 适配器    | **OpenAI**（Chat Completions）、**Anthropic**（Messages），基于可注入 `fetch`，无厂商官方 SDK 硬依赖         |
| 测试      | Echo 适配器、单测（重试、注册表、请求构建、Mock `fetch` 契约）                                               |
| 导出      | `@renx/provider` 根入口导出 LLM API；可选子路径 `./llm`                                                      |

---

## 2. 目标与非目标

### 2.1 目标

- 统一入口：`generateText`、`streamText`，支持**非流**与**流式**输出。
- **多厂商**通过 **Adapter** 扩展；字符串模型 ID（如 `anthropic/claude-3-5-sonnet`）与工厂函数（如 `anthropic("…")`）解析到同一执行路径。
- **Canonical 请求/响应**抹平传参与输出差异；厂商特有能力通过 **`providerOptions.<vendor>`** 透传。
- **统一错误体系**：可分类、可监控、可对终端用户映射文案；**可重试错误**可配置重试策略。
- **企业级非功能**：可观测性、安全、超时与重试语义、SLO 相关行为可解释、可测试。

### 2.2 非目标（产品边界，非「以后再实现 V1」）

- 内置提示词工程、RAG、Agent 编排（由上层应用负责）。
- 自动跨厂商 failover（可作为后续「路由层」能力）。
- 保证与第三方 SDK（如 Vercel AI SDK）类型级兼容（可提供可选适配说明）。

---

## 3. 架构概览

```
调用方
  → LLMClient（注册表、默认配置、hooks、重试）
    → generateText / streamText
      → 解析 ModelHandle → 选择 Adapter
        → Adapter：Canonical → Native → 厂商 API
        → Adapter：Native → Canonical（+ 可选 raw）
```

**包边界（V1 实现）**：

- `@renx/provider`：**完整**核心类型、错误、Client、注册表、`generateText` / `streamText`、OpenAI + Anthropic Adapter、Echo 测试 Adapter。
- `@renx/provider-<vendor>`：**可选**后续拆分（更小安装包、独立审计周期）；V1 默认随核心包发布，拆分时不改变公共 API 语义。

---

## 4. 对外 API 契约

### 4.1 创建客户端

- `createLLMClient(options)`：`registry`、`defaultRetry`、`defaultTimeout`、`fetch`、`logger`、`hooks` 等（见第 8、9 节）。

### 4.2 `generateText(options)`

**输入（逻辑字段）**：

- `model`：`ModelHandle | string`
- `prompt?: string` 与 `messages?: CanonicalMessage[]`：**二选一或明确优先级**（建议：`messages` 优先，否则由 `prompt` 合成单条 user 消息）。
- `temperature`、`maxOutputTokens`、`topP`、`stopSequences` 等 Canonical 生成参数。
- `abortSignal?`、`providerOptions?`、`retry?`（覆盖默认）、`metadata?`（关联 trace/租户，不落日志明文敏感字段）。

**输出（逻辑字段）**：

- `text: string`
- `finishReason: CanonicalFinishReason`
- `usage?: CanonicalUsage`（若厂商/流式延后提供，文档说明可用时机）
- `raw?: unknown`（调试；默认生产可关闭）

### 4.3 `streamText(options)`

**输入**：与 `generateText` 对齐（同一子集）。

**输出**：

- `textStream: AsyncIterable<CanonicalStreamChunk>`（或等价异步迭代器）
- 可选：`text: Promise<string>`（全文聚合）、`usage` / `finishReason` 的 Promise 或在最后 chunk 携带

**流式 chunk 类型（最小集）**：

- 文本增量：`{ type: 'text-delta', textDelta: string }`
- 结束：`{ type: 'finish', finishReason, usage? }`
- 是否暴露 `error` 事件：**建议以抛异常为主**；若采用事件，须文档说明与 `for await` 的交互，避免双重错误路径。

---

## 5. Canonical 数据模型

### 5.1 消息

- `role`: `system` | `user` | `assistant`
- `content`: **parts** 数组，首版至少 `{ type: 'text', text: string }`
- **顺序规则**：按数组顺序即为对话顺序；多条 `system` 的合并策略由 **Adapter 文档**说明（如合并为一条或按厂商要求重组）。

### 5.2 生成参数

- 仅包含**语义稳定**的通用字段；不支持的参数行为须在全局配置中二选一：**严格模式（抛错）** 或 **宽松模式（忽略 + 可选 warning 回调）**。

### 5.3 `finishReason`

统一枚举（示例）：`stop` | `length` | `content_filter` | `error` | `other`  
Adapter 负责将厂商 reason 映射至此；无法映射时用 `other` 并可在 `raw` 中保留原文。

### 5.4 `usage`

统一字段（示例）：`inputTokens`、`outputTokens`、`totalTokens?`  
若厂商仅提供估算或分项不同，Adapter 填最接近语义并在 `raw` 保留原数据。

### 5.5 `providerOptions`

```ts
// 概念结构
providerOptions?: {
  openai?: Record<string, unknown>;      // 或强类型子包
  anthropic?: Record<string, unknown>;
  [vendorId: string]: unknown;
};
```

- 调度层**原样下传**当前模型对应 Adapter；Adapter **仅消费本 vendor 键**。
- **不得**将未文档化的密钥字段通过 `providerOptions` 鼓励传入；密钥走 Client 构造或环境变量。

---

## 6. 模型解析与注册表

- 字符串 `vendor/model`：解析失败抛 `MODEL_NOT_FOUND` 或等价错误。
- 工厂函数：返回绑定 `vendorId`、`modelId`、默认 `providerOptions` 的 `ModelHandle`。
- 支持**运行时注册**与**内置注册**；同名模型后者策略须定义（覆盖 / 拒绝 / 警告）。

---

## 7. Adapter 契约

每个 Adapter **必须**实现：

1. **标识**：`vendorId`、支持的 `modelId` 列表或模式。
2. **`generateText(request: CanonicalRequest): Promise<CanonicalResult>`**
3. **`streamText(request: CanonicalRequest): Promise<AsyncIterable<CanonicalStreamChunk>>`**（先 `await` 完成建连，再迭代；便于对建连阶段做重试）
4. **`mapError(nativeError: unknown): LLMError`**：凡失败均映射为 `LLMError` 子类或带统一 `code` 的实例。
5. **`getCapabilities(): AdapterCapabilities`**（见下）

**Capabilities（建议字段）**：

- `streaming: boolean`
- `maxOutputTokens?: { min, max }`
- `supportsTopP`、`supportsStopSequences` 等布尔或枚举
- 可选：`notes` 供运维/文档生成

**Adapter 不得**：在核心包内硬编码其他厂商逻辑；跨厂商代码只能通过 Canonical 类型交互。

---

## 8. 错误体系

### 8.1 基类 `LLMError`

建议字段：

- `code: LLMErrorCode`（字符串联合类型，稳定、可监控）
- `message`（内部诊断，可含厂商摘要）
- `cause?: unknown`
- `vendor?: string`、`modelId?: string`
- `httpStatus?: number`
- `retryable: boolean` **或** 使用子类 `RetryableError`（二选一做唯一真相来源，禁止两套矛盾）

### 8.2 标准 `code` 清单（须与监控面板一致）

| code                  | 默认 retryable | 说明                                     |
| --------------------- | -------------- | ---------------------------------------- |
| `UNAUTHORIZED`        | 否             | 密钥/权限                                |
| `RATE_LIMIT`          | 是             | 429 及厂商等价                           |
| `QUOTA_EXCEEDED`      | 否\*           | 与限流区分；\*若业务可申诉可配置为可重试 |
| `INVALID_REQUEST`     | 否             | 参数、格式                               |
| `MODEL_NOT_FOUND`     | 否             |                                          |
| `MODEL_NOT_AVAILABLE` | 可配置         | 临时不可用                               |
| `TIMEOUT`             | 是             |                                          |
| `NETWORK`             | 是             | DNS、连接重置等                          |
| `PROVIDER_ERROR`      | 可配置         | 5xx                                      |
| `INVALID_RESPONSE`    | 否             | 解析失败                                 |
| `CONTENT_FILTER`      | 否             | 安全策略拦截                             |
| `ABORTED`             | 否             | 用户取消                                 |
| `UNKNOWN`             | 否             | 兜底                                     |

### 8.3 厂商自定义可重试

- Adapter 在 `mapError` 中将特定厂商 code / status 标为 `retryable: true` 并映射到合适 `code`。
- 可选全局 **`shouldRetry(error: LLMError): boolean`** 覆盖默认表（用于企业策略）。

### 8.4 用户可见文案

- 提供 **`toPublicMessage(code)`** 或映射表，**禁止**将厂商原始 body 直接展示给终端用户；内部日志可记录摘要（脱敏后）。

---

## 9. 重试、超时与取消

### 9.1 重试配置

- `maxAttempts`（含首次）或 `maxRetries`（文档统一一种命名）。
- `initialDelayMs`、`maxDelayMs`、`backoffMultiplier`、`jitter`（建议默认带 jitter 防止惊群）。
- **按 attempt 的 timeout** 与可选 **`deadline`（整次调用绝对截止时间）** 并存；达到 `deadline` 不再重试，抛 `TIMEOUT` 或 `ABORTED`。

### 9.2 可重试条件

- 仅当 `retryable === true`（或 `RetryableError`）且未取消、未超 deadline。
- **流式**：**默认仅允许在「首个 text-delta 之前」失败时重试**；首包已发出后失败**不重试**（避免重复输出），除非上层实现去重/可接受重复（须在文档标为高级选项且默认关闭）。

### 9.3 `AbortSignal`

- 任意 attempt 取消 → 立即终止，最终错误为 `ABORTED`。
- 重试循环须在每次新 attempt 前检查 signal。

---

## 10. 安全

- **密钥**：仅从环境变量、密钥管理服务或 Client 构造时注入；禁止写入日志与异常栈外的持久化。
- **日志脱敏**：默认不记录完整 prompt、完整响应、`Authorization`；错误日志仅记录 `code`、`requestId`（若有）、截断 body。
- **SSRF**：若存在「自定义 base URL」，须限制用途（仅内网网关白名单或禁止在公网多租户场景开放）。
- **依赖供应链**：Adapter 包单独版本与审计；核心包最小依赖。

---

## 11. 可观测性

### 11.1 结构化日志

- 字段建议：`event`、`vendor`、`modelId`、`latencyMs`、`attempt`、`outcome`、`code`、`traceId`。
- **禁止**默认记录 PII/PHI；`metadata` 中的租户 ID 可记录，内容字段不可。

### 11.2 Tracing

- 单次 `generateText` / `streamText` 对应一个 span；**每次重试**可为子 span 或带 `attempt` 属性。
- 注入或回传厂商 `request-id`（若存在）到 span attribute。

### 11.3 指标（建议）

- `llm_requests_total{vendor,model,outcome}`
- `llm_latency_seconds`（histogram）
- `llm_retries_total{vendor,code}`
- `llm_tokens_total{vendor,direction}`（在 usage 可用时）

### 11.4 Hooks（建议接口形态）

- `onRequestStart` / `onRequestEnd` / `onRetry` / `onStreamChunk`（`onStreamChunk` 默认关闭或采样，防日志爆炸）

---

## 12. 可靠性与容量

- **客户端并发**：可选 `maxConcurrentRequests` 或队列；防止突发把网关打满。
- **熔断**：可选集成（如连续失败打开熔断）；**默认可不实现**，但 Client 预留 `middleware` 或 `wrapAdapter` 扩展点。
- **DNS / TLS**：支持可注入 `fetch` 与 `Agent`（Node）以满足企业代理。

---

## 13. 运行时与环境

- 明确支持矩阵：**Node LTS**、是否支持 **Edge** / **Browser**（若支持，说明 CORS、密钥不可进前端）。
- **字符编码**：约定 `textDelta` 为 UTF-8 字符串拼接语义；若底层为 byte 流，Adapter 内完成解码。

---

## 14. 测试策略

| 层级 | 内容                                                                                      |
| ---- | ----------------------------------------------------------------------------------------- |
| 单元 | 错误映射表、`shouldRetry`、模型 ID 解析、Canonical 合并工具                               |
| 契约 | 每个 Adapter：给定 Canonical 输入，Mock HTTP，断言 Native 请求快照与 Canonical 输出不变量 |
| 集成 | 可选真 API（夜间流水线 + 密钥）；默认录播（golden file）                                  |
| 负载 | 可选：流式背压与并发压测（非阻塞首版）                                                    |

覆盖率目标：核心调度与错误路径 **≥ 85%**（与仓库测试规范对齐时可调整）。

---

## 15. 运维与 SLO

- **运行手册**：常见告警（限流飙升、5xx、延迟）与处置（换模型、扩容密钥池、联系厂商）。
- **降级**：上层可选用更便宜模型；Provider 层可提供 `timeout` 缩短快速失败。
- **配置**：重试与超时建议**按环境**区分（dev 少重试、prod 保守）。

---

## 16. 版本与兼容

- **SemVer**：公共类型与 `code` 枚举增广为 minor；删除/改语义为 major。
- **Adapter 与核心**：peer dependency 版本范围写清。
- **弃用模型**：注册表支持 `deprecated: true` 与日志警告。

---

## 17. 交付清单（Definition of Done）— V1 完整 SDK

- [ ] `generateText` / `streamText` 与本文档字段对齐，TypeScript 类型导出完整
- [ ] **OpenAI + Anthropic** 生产级 HTTP 适配器（非流 + SSE 流）+ **Echo** 适配器
- [ ] `LLMError` + `RetryableError` + 标准 `code` + `toPublicMessage`
- [ ] 可配置重试 + `AbortSignal` + `timeoutMs` + 可选整次 `deadlineMs` + `shouldRetry` 覆盖
- [ ] 流式重试语义：**仅建连阶段**可重试；body 读取阶段失败不重试
- [ ] Hooks：`onRequestStart` / `onRequestEnd` / `onRetry` / `onWarning` / 可选 `onStreamChunk`
- [ ] 可注入 `fetch`；**不在日志中打印**密钥与完整 prompt/响应（由 hooks 使用者遵守；SDK 提供结构化字段便于脱敏）
- [ ] 单元测试 + Mock `fetch` 契约测试；CI 内 `typecheck` + `test` 通过
- [ ] README：快速开始、环境变量、故障排查、`providerOptions` 示例

---

## 18. 附录：与现有仓库的衔接

- 请求上下文（如 `traceId`、`tenantId`）由调用方在 `metadata` / hooks 中传入即可，**不作为** LLM 核心的必需依赖。
- 实现代码位于 `packages/provider/src/llm/`；`package.json` 的 `exports` 提供根入口与可选 `./llm` 子路径。

---

---

## 19. 修订历史

| 版本 | 说明                                                                                                 |
| ---- | ---------------------------------------------------------------------------------------------------- |
| 1.1  | 明确 V1 为**完整企业级 SDK**交付范围；`streamText` 返回 `Promise<AsyncIterable<...>>` 以固定重试边界 |
| 1.0  | 初版规格                                                                                             |

**文档结束。** 实现时若偏离本文档，须在 PR 中说明理由并同步修订本规格版本号与修订历史。
