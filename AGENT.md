# AGENT.md

## 1. 项目定位

`renx-code-v4` 是一个基于 `pnpm` 的 TypeScript monorepo，当前重点是两层能力：

- `@renx/provider`
  - 统一多厂商 LLM / 多模态调用层
  - 已支持文本、流式文本、图像、语音、转写、视频、tool calling
- `@renx/agent`
  - 构建在 provider 之上的轻量 Agent 运行层
  - 当前已具备基础多轮 ReAct 循环、工具调用、中间件、权限确认、沙箱抽象
  - 但整体仍处于“雏形到正式 runtime”的过渡阶段

这不是一个典型的 Web App 仓库，核心是 SDK / runtime 能力本身。

## 2. Monorepo 结构

```text
.
├── packages/
│   ├── provider/   # 统一 LLM Provider SDK，成熟度最高
│   ├── agent/      # Agent 循环、工具执行、中间件、sandbox 抽象
│   └── examples/   # provider 和 agent 的可执行示例
├── docs/
│   └── agent-runtime-architecture/
│       # agent 目标架构设计文档，覆盖 runtime / harness / memory / sandbox 等
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── AGENT.md
```

补充观察：

- 根目录 `README.md` 基本为空，实际说明主要分散在 `packages/provider/README.md`、`packages/provider/docs/USAGE.md` 和 `docs/agent-runtime-architecture/`
- 仓库内已存在 `dist/`、`coverage/`、`tsbuildinfo` 等构建产物
- 当前工作区可能是脏的，改动前先看 `git status`

## 3. 技术栈与工程约定

- 包管理：`pnpm@10`
- 语言：TypeScript 5
- 模块系统：`NodeNext` / ESM
- 测试：Vitest
- Lint / Format：`oxlint`、`oxfmt`
- 运行示例：`tsx`
- schema 与工具参数：`zod`、`zod-to-json-schema`

根脚本：

```bash
pnpm lint
pnpm format
pnpm typecheck
pnpm build
pnpm test
```

常用定向命令：

```bash
pnpm --filter @renx/provider run build
pnpm --filter @renx/provider run test:coverage
pnpm --filter @renx/agent run test
pnpm --filter @renx/examples run demo:agent
```

## 4. 当前实现状态总览

### 4.1 已较成熟的部分

`packages/provider` 是仓库里最完整、最可直接复用的部分。

它已经具备：

- 统一 canonical request/response 类型
- 多厂商适配器注册表
- OpenAI / Anthropic / MiniMax 内置支持
- Functional API 和 Client API 双入口
- streaming / tool calling / multimodal message parts
- 图像、TTS、转写、视频任务与下载
- 错误映射、重试策略、默认 client 构建
- 较完整测试

### 4.2 处于演进中的部分

`packages/agent` 已经能跑真实多轮工具循环，但还不是设计文档中的完整 runtime。

当前已有：

- `Agent` 类对外入口
- `queryModel` 多轮循环
- Koa 风格 middleware
- tool registry
- tool execution read/write 分阶段执行
- permission confirm middleware
- sandbox registry 和默认 `in_process` backend
- LLM 调用失败后的 Agent 层有限重试

当前还没有形成设计稿中的完整模块：

- `AgentRuntime`
- `Harness`
- `RunStateMachine`
- `DecisionRouter`
- `ContextBuilder`
- `MemoryManager`
- `TerminationPolicy`
- checkpoint / 恢复机制

结论：

- 读 `packages/agent` 源码时，要把它理解为“最小可运行骨架”
- 读 `docs/agent-runtime-architecture/` 时，要把它理解为“目标架构规范”，不是现状清单

## 5. Provider 层怎么工作

核心入口：

- `packages/provider/src/index.ts`
- `packages/provider/src/llm/index.ts`

关键路径：

1. 业务代码调用 `generateText` / `streamText` 或显式 `createLLMClient`
2. `default-client.ts` 创建默认 client
3. `presets.ts` 按 vendor 组装 adapter registry
4. `client.ts` 负责参数标准化、调用 adapter、处理 hooks / retry / timeout
5. `build-canonical-request.ts` 把 prompt/messages/systemPrompt/tool 配置统一成 canonical request
6. 各 vendor adapter 负责协议转换和错误映射

关键概念：

- `model` 既可写 `"vendor/modelId"`，也可用 `openai("...")` / `anthropic("...")` / `minimax("...")`
- 多模态对话统一为 `MessagePart`
- tool calling 统一为 `CanonicalTool` / `CanonicalToolCall`
- 默认 client 内置 vendor：`openai`、`anthropic`、`minimax`
- 默认环境变量：`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`MINIMAX_API_KEY`

建议优先阅读：

- `packages/provider/docs/USAGE.md`
- `packages/provider/src/llm/client.ts`
- `packages/provider/src/llm/types.ts`
- `packages/provider/src/llm/adapters/openai-adapter.ts`
- `packages/provider/src/llm/adapters/anthropic-adapter.ts`
- `packages/provider/src/llm/minimax/adapter.ts`

## 6. Agent 层怎么工作

核心入口：

- `packages/agent/src/agent/agent.ts`

当前主链路：

1. `Agent.run(...)` 或 `Agent.createRun(...)`
2. `AgentRuntime.startRun(...)` / `resumeRun(...)`
3. `Harness`
4. `ContextBuilder` 生成本轮模型输入
5. `@renx/provider` 的 `streamText(...)` 或注入的 `LLMClient.streamText(...)`
6. drain stream，收集 `assistantText`、`toolCalls`、`finishReason`
7. 若返回 `tool_calls`，解析参数并进入 `ToolRuntime(...)`
8. 工具结果写回 `role: tool` message，更新 session/event trace，继续下一轮

关键文件：

- `packages/agent/src/agent/query-model-loop.ts`
- `packages/agent/src/model/runtime.ts`
- `packages/agent/src/conversation/tool-messages.ts`
- `packages/agent/src/tools/tool-executor.ts`
- `packages/agent/src/agent/middleware.ts`
- `packages/agent/src/agent/middlewares/permission-confirm.ts`

### 6.1 Middleware 机制

当前 Agent 的扩展点是 Koa 风格 middleware，支持事件：

- `beforeRun`
- `beforeStep`
- `beforeBuildContext`
- `beforeModelCall`
- `afterModelCall`
- `beforeToolExecution`
- `afterToolExecution`
- `beforeFinish`

中间件通过 `ctx.control`、`ctx.modelRequest`、`ctx.shared` 等 bucket 改写流程。

### 6.2 Tool 执行机制

工具定义使用 `AgentTool`：

- `name` / `description`
- `type`: `read_only` / `write_only` / `read_write`
- `schema`: Zod 参数校验
- `execute`
- `timeoutMs`
- `sandboxProfileId`

`toolExecutor` 的行为：

- 写工具串行执行
- 读工具并发执行
- 如果某个写工具失败，后续写工具和读阶段都会被跳过，并返回显式失败结果

### 6.3 Sandbox 机制

当前 sandbox 是抽象层，不是重隔离实现。

- 默认 registry 只有 `in_process`
- 默认 backend 只是进程内执行工具
- `SandboxRegistry` 的意义是给未来 Docker / Remote / Worker sandbox 预留扩展点

不要把当前 sandbox 理解为真正的安全边界。

### 6.4 Retry 责任分层

- Provider 默认 `maxAttempts: 1`，即默认不重试
- Agent 额外提供 `llmRetry`，用于对单轮 `runtime()` 失败做有限重试

这意味着：

- provider 负责基础 SDK 能力
- agent 负责更贴近任务循环的恢复策略

## 7. 示例与调试入口

示例主要在 `packages/examples/src/`：

- `provider/01-11-*`：覆盖文本、流式、多厂商、图像、语音、视频、tool calling、reasoning
- `agent/01-agent-query.ts`：最重要的 agent demo

其中 `01-agent-query.ts` 展示了：

- 初始化 `Agent`
- 配置 `llmRetry`
- 注册工具
- 使用 `createPermissionConfirmMiddleware`
- 通过 `onStreamChunk` 打印流式输出

如果要快速理解当前 agent 的真实行为，先跑这个 demo。

## 8. 测试现状

Vitest 根配置会加载 `packages/*/vitest.config.ts`。

测试重心：

- `provider` 测试较多，覆盖 adapter、integration、流式边界、functional API、MiniMax
- `agent` 测试主要覆盖 loop、runtime、middleware、permission、tool executor、sandbox registry

注意点：

- `packages/provider/vitest.config.ts` 配置了 90% coverage threshold
- `packages/agent/vitest.config.ts` 目前没有显式 coverage threshold

改动建议：

- 改 `provider` 公共 API 或 adapter，至少跑 provider 相关测试
- 改 `agent` 循环、middleware、tool 执行链，至少跑 agent 测试
- 改公开行为时，同时检查 examples 和 `packages/provider/docs/USAGE.md`

## 9. 阅读顺序建议

### 9.1 新人快速接手

1. `packages/provider/README.md`
2. `packages/provider/docs/USAGE.md`
3. `packages/agent/src/agent/agent.ts`
4. `packages/agent/src/agent/query-model-loop.ts`
5. `packages/examples/src/agent/01-agent-query.ts`

### 9.2 要做 agent 架构演进

1. `docs/agent-runtime-architecture/README.md`
2. `01-current-state-and-target.md`
3. `02-runtime-harness-react-loop.md`
4. `03-tool-permission-sandbox.md`
5. `06-implementation-roadmap.md`
6. 再回到 `packages/agent/src/` 对照现状

## 10. 协作时的高价值注意事项

1. 优先改 `src/`，不要把 `dist/` 当真实源码。
2. `docs/agent-runtime-architecture/` 不是实现目录映射，很多模块在代码里还不存在。
3. `provider` 和 `agent` 的职责边界要守住：
   - provider 处理模型协议与 canonical 化
   - agent 处理任务循环、工具、权限、编排
4. 改 tool calling、message parts、finish reason 时，要同时考虑 provider 和 agent 两层的兼容性。
5. 新增工具能力时，优先沿用现有 Zod schema + canonical tool 映射，而不是自定义一套参数系统。
6. 当前 sandbox 默认仍是进程内执行，涉及安全假设时要额外谨慎。
7. 根 `README.md` 信息不足，不要只凭 README 判断项目现状。
8. 当前工作区已存在未提交改动，协作时应避免误覆盖用户变更。

## 11. 对后续 Agent 的建议动作模板

### 11.1 做问题排查时

- 先确认问题属于 `provider` 还是 `agent`
- 再沿核心入口往下追
- 最后补看 examples 和相关测试

### 11.2 做功能新增时

- 若是模型接入、多模态、请求标准化，优先放在 `provider`
- 若是工具编排、权限、循环控制、运行时策略，优先放在 `agent`
- 若修改公共行为，补测试，并同步文档或示例

### 11.3 做 agent 架构重构时

- 先对照 `docs/agent-runtime-architecture/` 明确目标层次
- 统一使用 `Agent.run()` / `createRun()` / `startRun()` 新入口
- 避免一步把设计稿全部落地，优先沿当前 loop 渐进拆分

## 12. 一句话结论

这个仓库的现实核心是“一个相对成熟的多厂商 LLM provider 层 + 一个正在长成完整 runtime 的 agent 层”；做任何修改前，先分清你面对的是“已实现现状”还是“文档中的目标态”。
