# @renx/agent-v2 — 架构设计文档

## 目录

1. [设计哲学](#1-设计哲学)
2. [分层架构总览](#2-分层架构总览)
3. [Layer 1 — 基础原语](#3-layer-1--基础原语)
   - [3.1 RunState](#31-runstate)
   - [3.2 Message](#32-message)
   - [3.3 Tool](#33-tool)
   - [3.4 LLM Client](#34-llm-client)
4. [Layer 2 — 核心循环](#4-layer-2--核心循环)
   - [4.1 AgentEvent](#41-agentevent)
   - [4.2 agent() 生成器](#42-agent-生成器)
   - [4.3 执行流程](#43-执行流程)
   - [4.4 错误处理](#44-错误处理)
   - [4.5 暂停与恢复](#45-暂停与恢复)
5. [Layer 3 — 组合能力](#5-layer-3--组合能力)
   - [5.1 Plugin](#51-plugin)
   - [5.2 内置 Plugin](#52-内置-plugin)
   - [5.3 pipe() 组合](#53-pipe-组合)
   - [5.4 多 Agent 协作](#54-多-agent-协作)
   - [5.5 Agent as Tool](#55-agent-as-tool)
   - [5.6 Handoff](#56-handoff)
6. [Layer 4 — 基础设施](#6-layer-4--基础设施)
   - [6.1 RunManager](#61-runmanager)
   - [6.2 PersistenceAdapter](#62-persistenceadapter)
   - [6.3 Worker](#63-worker)
   - [6.4 遥测](#64-遥测)
7. [目录结构](#7-目录结构)
8. [API 速览](#8-api-速览)
9. [与 v1 对比](#9-与-v1-对比)
10. [迁移指南](#10-迁移指南)
11. [实现路线图](#11-实现路线图)

---

## 1. 设计哲学

### 核心命题

> **能生成事件流的纯函数，就是 Agent。**

基于这个命题，agent-v2 的设计遵循五条原则：

| 原则 | 含义 | 体现 |
|------|------|------|
| **Agent 是 AsyncGenerator** | 不是一个类，不是一个图，就是一个生成器函数。它能被 `for await`、能被 `pipe`、能被 `transform` | `agent()` 返回 `AsyncGenerator<AgentEvent, void, void>` |
| **类型即文档** | 类型系统承担 80% 的自解释工作，不依赖注释 | 每个概念都是精确的 TypeScript 类型 |
| **一切皆可序列化** | State、Event、Error 全部 JSON-safe，天生可持久化、可重放 | 所有类型不含 Symbol、函数、class 实例 |
| **流式是第一公民** | 不是"支持 streaming"，而是"只有 streaming" | 没有同步 API，所有路径都走 `for await` |
| **组合优于继承** | 没有 `Agent` 基类，只有函数组合和 plugin transform | 无 `class`，无 `extends`，无 `use()` |

### 设计目标

- **极简核心**：`agent()` 函数 + `AgentEvent` 类型 = 一个完整可用的 agent
- **渐进增强**：Plugin、RunManager、Worker 都是可选的叠加层
- **零配置启动**：一行代码即可运行
- **生产就绪**：持久化、重放、分布式、遥测都是内置能力
- **可测试**：纯函数设计，传入假 LLM client 即可单元测试

---

## 2. 分层架构总览

```
┌──────────────────────────────────────────────────────────────┐
│  Layer 4  基础设施                                            │
│  RunManager · PersistenceAdapter · Worker · Telemetry        │
│  管理运行生命周期、持久化状态、分布式消费、可观测性               │
├──────────────────────────────────────────────────────────────┤
│  Layer 3  组合能力                                            │
│  Plugin · pipe() · agentAsTool · handoff                     │
│  用函数组合装配 agent 行为，实现多 agent 协作                   │
├──────────────────────────────────────────────────────────────┤
│  Layer 2  核心循环                                            │
│  agent() AsyncGenerator<AgentEvent, void, void>             │
│  ReAct 循环实现：LLM 调用 → 决策 → 工具执行 → 循环             │
├──────────────────────────────────────────────────────────────┤
│  Layer 1  基础原语                                            │
│  RunState · Message · Tool · LLMClient                       │
│  不可变的类型定义，构成 agent 的"词汇表"                        │
└──────────────────────────────────────────────────────────────┘
```

**依赖方向**：Layer 1 ← Layer 2 ← Layer 3 ← Layer 4
上层可以引用下层，下层绝不引用上层。每一层都可以独立使用和测试。

---

## 3. Layer 1 — 基础原语

### 3.1 RunState

RunState 是 agent 运行期间的完整状态快照。它是**不可变的**——状态更新通过创建新对象完成，而非修改旧对象。

```typescript
/**
 * Agent 运行期间的完整状态。
 * 每个字段都是 JSON-serializable，确保可持久化和重放。
 */
type RunState = {
  /** 唯一运行标识，由调用方传入或自动生成 */
  runId: string;

  /** 运行状态 */
  status: RunStatus;

  /** LLM 模型标识 */
  model: string;

  /** 系统提示词 */
  systemPrompt: string;

  /** 完整对话历史 */
  messages: Message[];

  /**
   * Agent 自身的工作记忆。
   * 与 messages 分离——messages 是 LLM 的对话上下文，
   * workingMemory 是 agent 内部的变量空间，不需要进 prompt。
   *
   * 用途举例：
   * - 记录文件路径（避免重复搜索）
   * - 存储中间计算结果
   * - 标记阶段性任务完成状态
   * - 记录上一次工具调用的副作用
   */
  workingMemory: Record<string, unknown>;

  /** 当前已执行的步骤数 */
  stepCount: number;

  /** 累计的 token 使用量 */
  tokenUsage: TokenUsage;

  /** 运行开始时间戳 */
  startedAt: number;

  /** 最后一次活动的时间戳（用于 lease 判断） */
  lastActiveAt: number;
};

type RunStatus =
  | "ready"            // Run 已创建但尚未开始执行
  | "running"          // 正常执行中
  | "waiting_input"    // 暂停，等待用户输入
  | "waiting_approval" // 暂停，等待用户审批工具调用
  | "completed"        // 正常完成
  | "failed"           // 执行失败
  | "cancelled";       // 被取消

type TokenUsage = {
  input: number;
  output: number;
};
```

**设计要点：**

- `workingMemory` 与 `messages` 分离是关键决策。LLM 的上下文窗口是稀缺资源，agent 内部状态不应混入对话历史。
- 所有字段都是 plain data，没有 class 实例。这意味着 `JSON.parse(JSON.stringify(state))` 完全可用。
- `status` 采用字符串联合类型而非 enum，便于序列化和跨语言通信。

---

### 3.2 Message

沿用业界标准的 role + content 模式，不做重新发明。

```typescript
type Message =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;

type SystemMessage = {
  role: "system";
  content: string;
};

type UserMessage = {
  role: "user";
  content: string | ContentBlock[];
};

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "tool_result"; toolCallId: string; content: string };

type AssistantMessage = {
  role: "assistant";
  content: string | null;
  toolCalls?: ToolCall[];
};

type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

type ToolMessage = {
  role: "tool";
  toolCallId: string;
  content: string;
};
```

**设计要点：**

- `AssistantMessage.content` 可以为 `null`——当 LLM 只返回 tool calls 无文本时
- `ToolCall.arguments` 是已解析的 `Record<string, unknown>` 而非 JSON 字符串——解析在 LLM client 层完成
- `ContentBlock` 支持 `tool_result` 类型，允许 tool 结果直接嵌入 user message（某些 provider 需要这种格式）

---

### 3.3 Tool

Tool 的定义追求极简。一个 tool 就是一个有名字、有描述、有 schema、有 execute 函数的对象。

```typescript
/**
 * Agent 可调用的工具。
 * @typeParam I - execute 的输入参数类型，由 schema 推断
 * @typeParam O - execute 的输出类型
 */
type Tool<I = unknown, O = unknown> = {
  /** 工具唯一名称 */
  name: string;

  /** 工具功能描述，会被注入到 LLM 的 system prompt 中 */
  description: string;

  /** 参数 schema，使用 Zod 定义 */
  parameters: ZodSchema<I>;

  /** 执行工具，接收 parsed + validated 的参数 */
  execute: (input: I, ctx: ToolContext) => Promise<O>;
};

/**
 * 工具执行时的上下文。
 */
type ToolContext = {
  /** 当前运行的 runId */
  runId: string;

  /** Agent 的工作记忆，工具可以读写 */
  workingMemory: Record<string, unknown>;

  /** 取消信号，工具应该监听并尊重 */
  signal: AbortSignal;
};
```

**设计要点：**

- 没有 `ToolRegistry` 类。tools 作为参数直接传给 `agent()`，在函数签名中声明依赖。
- `execute` 的第二个参数 `ctx` 提供 `workingMemory` 的读写权限，工具可以在执行期间更新 agent 状态。
- `signal` 确保长时间运行的工具可以被取消。
- 不区分 read_only / write_only / read_write——这不是 agent 框架该规定的事。如果需要，通过 Plugin 实现。
- 不支持 `sandboxProfileId`——sandbox 隔离是基础设施层（Runner）的职责，不是 tool 定义的一部分。

**Tool 创建示例：**

```typescript
import { z } from "zod";

const readFileTool: Tool = {
  name: "read_file",
  description: "Read the contents of a file at the given path",
  parameters: z.object({
    path: z.string().describe("Absolute path to the file"),
  }),
  async execute({ path }, ctx) {
    const content = await fs.readFile(path, "utf-8");
    // 可选：更新 workingMemory，记录已读取的文件
    ctx.workingMemory.lastReadFile = path;
    return { path, content, lineCount: content.split("\n").length };
  },
};
```

---

### 3.4 LLM Client

LLM Client 是 agent 与 LLM provider 之间的最小合约。核心假设：**LLM 调用本身也是一个 AsyncGenerator**。

```typescript
/**
 * LLM 客户端的最小接口。
 * 每次调用 stream() 返回一个生成器，逐块产出数据。
 */
type LLMClient = {
  /**
   * 发起流式 LLM 请求。
   * @returns AsyncGenerator，每个 yield 代表一个流式数据块
   */
  stream: (request: LLMStreamRequest) => LLMStreamGenerator;
};

type LLMStreamGenerator = AsyncGenerator<LLMChunk, void, void>;

type LLMStreamRequest = {
  model: string;
  systemPrompt: string;
  messages: Message[];
  tools?: CanonicalToolSchema[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
};

/**
 * LLM 流式响应的数据块。
 * 四种块类型覆盖 LLM 流式响应的所有情况。
 */
type LLMChunk =
  | LLMTextDeltaChunk
  | LLMToolCallDeltaChunk
  | LLMFinishChunk
  | LLMErrorChunk;

type LLMTextDeltaChunk = {
  type: "text-delta";
  /** 增量文本 */
  delta: string;
};

type LLMToolCallDeltaChunk = {
  type: "tool-call-delta";
  /** 工具调用的唯一 ID */
  id: string;
  /** 工具名称 */
  name: string;
  /** 增量参数 JSON 片段（需要应用层攒成完整 JSON） */
  argsDelta: string;
};

type LLMFinishChunk = {
  type: "finish";
  /** 结束原因：stop / tool_calls / length / content_filter */
  finishReason: string;
  /** 本次调用的 token 用量 */
  usage: TokenUsage;
};

type LLMErrorChunk = {
  type: "error";
  /** 错误信息 */
  error: AgentError;
};

/** 规范化后的工具 schema（用于传给 LLM） */
type CanonicalToolSchema = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

type JsonSchema = Record<string, unknown>;
```

**设计要点：**

- `LLMClient` 只有一个方法 `stream()`。不提供非流式 API——agent 核心循环只处理流。
- `LLMChunk` 的四种变体精准覆盖 LLM 流式响应的所有形态：文本增量、工具调用增量、结束、错误。
- `tool-call-delta` 的 `argsDelta` 是增量字符串，agent 内部负责攒成完整 JSON 再解析。
- `finishReason` 是字符串而非枚举，因为不同 provider 的值可能不同（如 `"STOP"` vs `"stop"`）。

**与 v1 的差异：**
- v1 的 `QueryModelType` 包含了 `GenerateTextOptions` 的扩展，这里是精简后的独立类型。
- v1 的 `RuntimeOutcome` 是一个 `ok: true | false` 的联合，这里通过 `LLMChunk` 的 `error` 变体在流中处理错误。

---

## 4. Layer 2 — 核心循环

### 4.1 AgentEvent

AgentEvent 是 agent 运行期间产出的所有事件的精确联合类型。总共 **14 种事件**，覆盖 agent 生命周期的所有环节。

```typescript
type AgentEvent =
  // ── 生命周期 ──
  | RunStartedEvent
  | StepStartedEvent
  | StepCompletedEvent
  | RunFinishedEvent

  // ── LLM 流式输出 ──
  | LLMDeltaEvent
  | LLMToolCallEvent
  | LLMDoneEvent

  // ── 工具执行 ──
  | ToolStartEvent
  | ToolResultEvent
  | ToolErrorEvent

  // ── 控制事件 ──
  | PauseInputEvent
  | PauseApprovalEvent
  | CancelledEvent

  // ── 多 Agent ──
  | HandoffEvent;


// === 生命周期事件 ===

type RunStartedEvent = {
  type: "run:started";
  runId: string;
  model: string;
  systemPrompt: string;
  tools?: string[];
  maxSteps: number;
};

type StepStartedEvent = {
  type: "step:started";
  step: number;
};

type StepCompletedEvent = {
  type: "step:completed";
  step: number;
  finishReason: string;
  tokenUsage: TokenUsage;
};

type RunFinishedEvent = {
  type: "run:finished";
  outcome: AgentResult;
};


// === LLM 事件 ===

type LLMDeltaEvent = {
  type: "llm:delta";
  /** 此增量所属的 LLM 调用轮次 */
  step: number;
  /** 增量文本 */
  delta: string;
};

type LLMToolCallEvent = {
  type: "llm:tool-call";
  step: number;
  /** 工具调用 ID */
  id: string;
  /** 工具名称（LLM 决定调用什么） */
  name: string;
  /** 解析后的参数 */
  arguments: Record<string, unknown>;
};

type LLMDoneEvent = {
  type: "llm:done";
  step: number;
  /** 结束原因 */
  finishReason: string;
  /** 累计 token 用量 */
  usage: TokenUsage;
  /** 完整文本输出（如果 LLM 返回了文本） */
  text: string | null;
};


// === 工具事件 ===

type ToolStartEvent = {
  type: "tool:start";
  /** 工具调用 ID */
  callId: string;
  /** 工具名称 */
  name: string;
  /** 工具参数 */
  arguments: Record<string, unknown>;
};

type ToolResultEvent = {
  type: "tool:result";
  callId: string;
  /** 执行是否成功 */
  ok: boolean;
  /** 工具输出 */
  output: unknown;
  /** 执行耗时（毫秒） */
  durationMs: number;
};

type ToolErrorEvent = {
  type: "tool:error";
  callId: string;
  /** 错误信息 */
  error: string;
};


// === 控制事件 ===

type PauseInputEvent = {
  type: "pause:input";
  /** 暂停原因（为何需要用户输入） */
  reason: string;
  /** 暂停前的 runId（用于恢复） */
  runId: string;
};

type PauseApprovalEvent = {
  type: "pause:approval";
  runId: string;
  /** 待审批的工具调用 ID 列表 */
  callIds: string[];
  /** 工具名称列表 */
  tools: string[];
  /** 工具参数（便于用户做出审批决定） */
  arguments: Record<string, unknown>[];
};

type CancelledEvent = {
  type: "run:cancelled";
  runId: string;
  /** 取消时的步骤数 */
  step: number;
};

type HandoffEvent = {
  type: "handoff";
  /** 来源 agent 的 runId */
  from: string;
  /** 目标 agent 的名称 */
  to: string;
  /** 转移原因 */
  reason: string;
};
```

**事件流示意（一次典型的 tool-calling 步骤）：**

```
run:started
  └─ step:started
       ├─ llm:delta ("I'll look up the weather...")
       ├─ llm:delta (" for New York.")
       └─ llm:tool-call (call_1, "get_weather", {location: "New York"})
     llm:done  (finishReason: "tool_calls", text: "I'll look up...")
       ├─ tool:start  (call_1, "get_weather")
       └─ tool:result (call_1, ok: true, {temp: 72F})
  ─ step:completed
  ─ step:started
       ├─ llm:delta ("The weather in New York is 72°F...")
       └─ llm:done  (finishReason: "stop")
  ─ step:completed
run:finished
```

**设计要点：**

- 每种事件都有明确的 `type` 字段作为 discriminator，TypeScript 能自动 narrow。
- `llm:delta` 逐字符产出文本增量，调用方可以直接写入 `process.stdout` 实现打字机效果。
- `tool:result` 包含 `durationMs`，方便监控性能。
- `llm:tool-call` 的 `arguments` 已经是解析好的对象——解析在内部完成。
- 控制事件（`pause:input`、`pause:approval`）是**暂停信号**，不是阻塞 API。

---

### 4.2 agent() 生成器

```typescript
/**
 * agent 的输入参数。
 */
type AgentInput = {
  /** 运行标识。调用方传入则使用，否则 agent() 内部自动生成 */
  runId?: string;

  /** LLM 模型标识 */
  model: string;

  /** 系统提示词 */
  systemPrompt: string;

  /** 初始消息列表 */
  messages: Message[];

  /** 可用的工具列表 */
  tools?: Tool[];

  /** 最大 ReAct 循环步数，默认 10 */
  maxSteps?: number;

  /** LLM 客户端，如果不传则使用全局默认客户端 */
  llmClient?: LLMClient;

  /**
   * Agent 的工作记忆初始值（可选）。
   * 恢复运行时可以传入之前保存的值。
   */
  workingMemory?: Record<string, unknown>;

  /** 取消信号 */
  signal?: AbortSignal;

  /** 工具执行模式。默认 "parallel" */
  toolExecution?: "parallel" | "sequential";

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Plugin 注入点（详见 PLUGIN-DESIGN.md）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * 工具决策回调。Plugin 通过此字段注入审批、日志、过滤等逻辑。
   * agent() 在每次执行工具前调用此回调，等待决策后再决定执行/拒绝/暂停/终止。
   *
   * 这是 agent() 和 Plugin 之间的**唯一接触点**。
   * 如果不设置，agent() 默认直接执行所有工具调用。
   */
  onTools?: (ctx: OnToolsContext) => Promise<OnToolsDecision>;
};

/**
 * onTools 回调接收的上下文。
 */
type OnToolsContext = {
  /** 待处理的工具调用列表 */
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[];

  /** 当前运行状态快照 */
  state: RunState;

  /**
   * 恢复运行时 RunManager 注入的审批结果。
   * 首次运行时为 undefined；恢复运行时包含之前暂停的审批决策。
   *
   * 注意：此字段由 RunManager 在内部通过 InternalRunContext 注入，
   * 不在 AgentInput 的公开签名字段中。
   */
  priorApprovals?: { callId: string; action: "allow" | "deny" }[];
};

/**
 * onTools 回调的返回值。
 */
type OnToolsDecision =
  | { action: "execute" }
  | { action: "deny";   callIds: string[]; reason: string }
  | { action: "abort";  reason: string }
  | { action: "pause";  callIds: string[]; reason: string };

/**
 * agent 运行完成后产出的最终结果。
 * 通过 run:finished 事件的 outcome 字段传递，而非 generator return 值。
 */
type AgentResult = {
  /** 运行标识 */
  runId: string;
  /** 完整对话历史 */
  messages: Message[];
  /** 最终文本输出 */
  text: string;
  /** agent 的工作记忆最终状态 */
  workingMemory: Record<string, unknown>;
  /** 累计 token 用量 */
  tokenUsage: TokenUsage;
  /** 结束原因 */
  finishReason: "stop" | "error" | "max_steps" | "handoff" | "cancelled";
  /** 总步骤数 */
  totalSteps: number;
  /** 如果运行失败或取消，此项非空 */
  error?: AgentError;
  /** 如果 finishReason === "handoff"，此项非空 */
  handoff?: HandoffInfo;
};

/**
 * Handoff 的目标信息。
 */
type HandoffInfo = {
  targetAgent: string;
  reason: string;
};

/**
 * agent 生成器的类型。
 * yield: 进度事件
 * return: void（结果通过 run:finished 事件传递，详见附录 C.1）
 */
type AgentGenerator = AsyncGenerator<AgentEvent, void, void>;

/**
 * 核心 agent 函数。
 * 接收输入，返回一个事件流生成器。
 * 结果通过 run:finished 事件传递，详见附录 C.1。
 */
declare function agent(input: AgentInput): AgentGenerator;

/**
 * RunManager 使用的内部上下文。
 * 不对外暴露，用于在恢复运行时注入审批结果等内部数据。
 *
 * agent() 的**内部实现**接收 AgentInput & InternalRunContext，
 * 但**公开类型签名**只接受 AgentInput。
 */
type InternalRunContext = {
  /** 恢复运行时注入的审批决策（RunManager 写，onTools 内读取） */
  resumeApprovals?: { callId: string; action: "allow" | "deny" }[];
};
```

**使用方式一：只消费最终结果**

```typescript
let result: AgentResult | undefined;

for await (const event of agent({
  model: "claude-sonnet-4-20250514",
  systemPrompt: "You are a helpful assistant.",
  messages: [{ role: "user", content: "What is 2+2?" }],
})) {
  if (event.type === "run:finished") {
    result = event.outcome;
  }
}

console.log(result.text); // "2+2 equals 4."
```

**使用方式二：消费流式事件**

```typescript
for await (const event of agent({
  model: "claude-sonnet-4-20250514",
  systemPrompt: "You are a code reviewer.",
  messages: [{ role: "user", content: "Review this code: ..." }],
  tools: [readFileTool, commentTool],
})) {
  switch (event.type) {
    case "llm:delta":
      process.stdout.write(event.delta);
      break;
    case "tool:start":
      console.log(`\n[TOOL] Calling ${event.name}...`);
      break;
    case "tool:result":
      console.log(`[TOOL] ${event.name} → ${event.ok ? "OK" : "FAILED"}`);
      break;
    case "run:finished":
      console.log(`\nDone in ${event.outcome.totalSteps} steps`);
      break;
  }
}
```

**使用方式三：利用 TypeScript 类型收窄**

```typescript
for await (const event of gen) {
  // TypeScript 自动收窄每个 case
  if (event.type === "llm:delta") {
    event.delta;  // string
  } else if (event.type === "tool:result") {
    event.output; // unknown
  }
}
```

---

### 4.3 执行流程

`agent()` 函数内部的执行逻辑如下（伪代码）：

```
function* agent(input):
  state ← initState(input)
  yield { type: "run:started", ... }

  while state.stepCount < input.maxSteps:
    yield { type: "step:started", step: state.stepCount + 1 }
    state.stepCount += 1

    // === 阶段 1: LLM 调用 ===
    chunks ← []
    for each chunk from input.llmClient.stream(state):
      if chunk.type === "text-delta":
        yield { type: "llm:delta", delta: chunk.delta }
        append chunk to chunks

      else if chunk.type === "tool-call-delta":
        accumulateToolCall(acc, chunk)
        // 注意：llm:tool-call 事件在 finish chunk 到达时统一产出
        // 因为 tool call 的 args JSON 需要所有 delta 到达后才能拼完整

      else if chunk.type === "finish":
        // 先 finalize 所有 tool calls，产出 llm:tool-call 事件
        for each [id, entry] of acc:
          parsed ← finalizeToolCall(acc, id)
          if parsed:
            yield { type: "llm:tool-call", step, id, name: parsed.name, arguments: parsed.arguments }
        yield { type: "llm:done", finishReason, usage, text }
        update state.tokenUsage
        break

      else if chunk.type === "error":
        // ⚠️ 不 throw！错误通过事件流传播，以便 withRetry Plugin 拦截
        yield { type: "llm:done", finishReason: "error", error: chunk.error }
        // 本轮调用结束，不继续处理
        done = true
        break

      // 检查取消信号
      if input.signal?.aborted:
        yield { type: "run:cancelled" }
        return

    llmResult ← parseAccumulatedChunks(chunks)

    // === 阶段 2: 决策路由 ===
    if llmResult.finishReason === "stop":
      appendAssistantMessage(state, llmResult.text)
      yield { type: "step:completed", step: state.stepCount }
      yield { type: "run:finished", outcome: buildResult(state) }
      return buildResult(state)

    if llmResult.finishReason === "length":
      if not already warned about length:
        injectWarning(state)
        continue
      else:
        yield { type: "step:completed" }
        yield { type: "run:finished", outcome: buildResult(state) }
        return buildResult(state)

    if llmResult has toolCalls:
      // 追加 assistant 消息（含 tool calls）
      appendAssistantWithToolCalls(state, llmResult)

      // === 阶段 2.5: ★ onTools 注入点 —— Plugin 的唯一接触点 ★ ===
      if input.onTools:
        decision ← await input.onTools({
          toolCalls: llmResult.toolCalls,
          state,
          priorApprovals: /* InternalRunContext.resumeApprovals */,
        })

        if decision.action === "abort":
          yield { type: "run:finished", outcome: buildResult(state) }
          return

        if decision.action === "deny":
          // 过滤掉被拒绝的 tool calls
          toolCalls ← filter out toolCalls in decision.callIds

        if decision.action === "pause":
          // 产出暂停信号，终止当前生成器（RunManager 负责保存状态并等待恢复）
          yield { type: "pause:approval", runId: state.runId, callIds: decision.callIds, ... }
          return

      // === 阶段 3: 工具执行 ===
      // 3a. 校验 tools（找出不存在的 tool name 和存在的 tool calls）
      for each toolCall in toolCalls:
        tool ← findTool(input.tools, toolCall.name)
        if tool not found:
          yield { type: "tool:error", callId, error: "Tool not found" }
          mark for error message

      // 3b. 并发模式：先 emit 所有 tool:start，再并发执行，最后 emit 结果
      if input.toolExecution !== "sequential":
        for each validToolCall:
          yield { type: "tool:start", callId, name, arguments }

        results ← Promise.allSettled(
          validToolCalls.map(toolCall → executeOneTool(toolCall, ctx))
        )

        for each result of results:
          if fulfilled:
            yield { type: "tool:result", callId, ok: true, output, durationMs }
            appendToolResultMessage(state, toolCall, stringify(output))
          else:
            yield { type: "tool:error", callId, error: error.message }
            appendToolErrorMessage(state, toolCall, error.message)

      // 3c. 顺序模式：逐个执行
      else:
        for each validToolCall:
          yield { type: "tool:start", callId, name, arguments }
          try:
            result ← tool.execute(args, {
              runId: state.runId,
              workingMemory: state.workingMemory,
              signal: input.signal
            })
            yield { type: "tool:result", callId, ok: true, output: result, durationMs }
            appendToolResultMessage(state, toolCall, stringify(result))
          catch error:
            if error instanceof HandoffSignal:
              yield { type: "handoff", from: state.runId, to: error.targetName, reason: error.reason }
              return { ...buildPartialResult(state), finishReason: "handoff", handoff: { ... } }
            yield { type: "tool:error", callId, error: error.message }
            appendToolErrorMessage(state, toolCall, error.message)

      // 处理之前标记的"tool not found"错误消息
      for each notFoundCall:
        appendToolErrorMessage(state, call, "Tool not found")

      yield { type: "step:completed", step: state.stepCount }

    else:
      // finishReason === "stop" 但没有 toolCalls → 最终答案
      appendAssistantMessage(state, llmResult.text)
      yield { type: "step:completed", step: state.stepCount }
      yield { type: "run:finished", outcome: buildResult(state) }
      return buildResult(state)

  // 超过 maxSteps
  appendAssistantMessage(state, "(I've reached the maximum number of steps.)")
  yield { type: "run:finished", outcome: buildResult(state) }
  return buildResult(state)
```

**核心流程图：**

```
                   ┌─────────┐
                   │  Start  │
                   └────┬────┘
                        │
                  yield run:started
                        │
                   ┌────▼────┐
          ┌───────│  Step   │◄──────────────┐
          │       └────┬────┘               │
          │      yield step:started         │
          │            │                    │
          │   ┌────────▼────────┐          │
          │   │   LLM Client    │          │
          │   │   .stream()     │          │
          │   └────────┬────────┘          │
          │            │                   │
          │   ┌────────▼────────┐          │
          │   │  Parse Chunks   │          │
          │   │  yield:         │          │
          │   │  llm:delta      │          │
          │   │  llm:tool-call  │          │
          │   │  llm:done       │          │
          │   └────────┬────────┘          │
          │            │                   │
          │   ┌────────▼────────┐          │
          │   │  Decision       │          │
          │   │  Router         │          │
          │   └───┬───┬────┬────┘          │
          │       │   │    │               │
          │    stop  │  error    tool_calls│
          │       │   │    │               │
          │       │   │    │     ┌─────────▼─────────┐
          │       │   │    │     │  Execute Tools    │
          │       │   │    │     │  yield:           │
          │       │   │    │     │  tool:start       │
          │       │   │    │     │  tool:result      │
          │       │   │    │     │  tool:error       │
          │       │   │    │     └────────┬──────────┘
          │       │   │    │              │
          │       │   │    │     yield step:completed
          │       │   │    │              │
          │       │   │    │     stepCount < maxSteps?
          │       │   │    │──────YES──────┘
          │       │   │    │
          │       │   │    NO ──► max steps reached
          │       │   │
          │   ┌───▼───▼────▼────┐
          │   │  Build Result   │
          │   │  yield:         │
          │   │  run:finished   │
          │   │  return result  │
          │   └───────┬─────────┘
          │           │
          └─── Done ──┘
```

---

### 4.4 错误处理

agent-v2 采用"流中处理错误"的模型。所有错误都通过 AgentEvent 暴露，而非抛异常。

**错误分类：**

| 错误类型 | 处理方式 | 表现 |
|----------|----------|------|
| LLM 调用错误 | 重试或降级 | `llm:done` 带 error finishReason |
| Tool 执行错误 | 返回错误消息给 LLM | `tool:error` 事件 |
| Tool 未找到 | 返回错误消息给 LLM | `tool:error` 事件 |
| 取消 | 立即终止 | `run:cancelled` 事件 |
| Token 超限 | 警告 LLM + 最后一次机会 | 继续循环或结束 |
| 不可恢复错误 | 终止运行 | `run:finished` 带 error 字段 |

**错误类型的定义：**

```typescript
type AgentError = {
  /** 错误码 */
  code: AgentErrorCode;
  /** 错误信息 */
  message: string;
  /** 是否可重试 */
  retryable: boolean;
  /** 原始错误 */
  cause?: unknown;
};

type AgentErrorCode =
  | "LLM_UNAVAILABLE"      // LLM 服务不可达
  | "LLM_RATE_LIMITED"     // 速率限制
  | "LLM_CONTENT_FILTER"   // 内容被过滤
  | "LLM_TOKEN_LIMIT"      // Token 超限
  | "TOOL_NOT_FOUND"       // LLM 调用了不存在的工具
  | "TOOL_EXECUTION_FAILED"// 工具执行失败
  | "TOOL_TIMEOUT"         // 工具执行超时
  | "CANCELLED"            // 被取消
  | "MAX_STEPS_REACHED"    // 达到最大步数
  | "INVALID_STATE";       // 内部状态异常
```

**AgentResult 错误结果：**

正常完成时 `finishReason = "stop"`, `error` 为 `undefined`。异常终止时 `finishReason = "error"` 或 `"cancelled"`，`error` 非空。详见附录 C.13。参见上文 §4.2 中 `AgentResult` 的完整定义。

---

### 4.5 暂停与恢复

agent-v2 支持两种暂停模式：**等待输入**和**等待审批**。

**暂停事件：**

```typescript
// 当 agent 决定需要用户输入时发出
type PauseInputEvent = {
  type: "pause:input";
  reason: string;
  runId: string;
};

// 当工具调用需要用户审批时发出
type PauseApprovalEvent = {
  type: "pause:approval";
  runId: string;
  callIds: string[];
  tools: string[];
  arguments: Record<string, unknown>[];
};
```

**恢复运行：**

agent 自身不处理恢复——恢复是 RunManager 的职责（参见 §6.1）。agent 函数在 pause 后只是停止 yield 事件。恢复运行意味着用新的 state 和新的 user messages 再次启动 agent。

```typescript
// agent 函数本身不感知暂停和恢复
// 暂停由 Plugin（如 withApproval）注入暂停事件
// 恢复由 RunManager 用更新后的 state 重新调用 agent()
```

**暂停语义：**

- `pause:input`：agent 停下来等待用户提供额外信息。相当于 `waiting_input` 状态。
- `pause:approval`：agent 停下来等待用户批准工具调用。相当于 `waiting_approval` 状态。

---

## 5. Layer 3 — 组合能力

### 5.1 Plugin

Plugin 是 agent-v2 最核心的扩展机制。**Plugin 就是一个高阶函数：接受 agent 生成器函数，返回 agent 生成器函数。**

```typescript
/**
 * Plugin 类型。
 *
 * Plugin 是一个高阶函数，它将一个 agent 生成器包装成另一个。
 * 因为输入和输出是同一种类型，Plugin 可以无限组合。
 *
 * @example
 * const enhancedAgent = withLogging(logger)(
 *   withRetry({ maxRetries: 3 })(
 *     withApproval(approver)(
 *       agent
 *     )
 *   )
 * );
 */
type Plugin = (
  inner: (input: AgentInput) => AgentGenerator
) => (input: AgentInput) => AgentGenerator;
```

**Plugin 可以做什么（比 v1 的 Hook 更强大）：**

| 能力 | v1 Hook | v2 Plugin |
|------|---------|-----------|
| 拦截事件 | ✓ `onEvent()` | ✓ |
| 修改 input | ✓ `assignRunProfile()` | ✓ |
| 审批工具 | ✓ `authorizeTools()` | ✓ |
| **修改/过滤事件** | ✗ | ✓ 可以 drop、transform |
| **观察并修改 state** | ✗ | ✓ 可以读写 workingMemory |
| **拦截 LLM 调用** | ✗ | ✓ 可以在 LLM 调用前后插入逻辑 |
| **组合多个** | `agent.use(a, b, c)` | `pipe(a, b, c, agent)` |
| **条件执行** | ✗ | ✓ 根据 input 决定是否 apply |

**Plugin 的三种形态：**

```typescript
// ── 形态一：事件观察型（for-await 包装，不改 input）──
// 典型的 "洋葱皮" 模式：在外面包一层 for-await，只观察/变换事件

function withLogging(logger: Logger): Plugin {
  return (inner) =>
    async function* (input) {
      logger.info({ runId: input.runId }, "agent:start");
      for await (const event of inner(input)) {
        logger.debug(event, "agent:event");
        yield event;
      }
      logger.info({ runId: input.runId }, "agent:end");
    };
}

// ── 形态二：input 注入型（改写 input 后传给 inner）──
// 用于需要介入 agent() 内部行为的 Plugin（审批、过滤等）
// 通过设置 input.onTools 来实现

function withApproval(approve: ApproveFn): Plugin {
  return (inner) =>
    async function* (input) {
      // 构造新的 input，注入 onTools 回调
      const guardedInput: AgentInput = {
        ...input,
        onTools: createToolGuard(input, approve),
      };
      yield* inner(guardedInput);  // ← 用修改过的 input 调用下一层
    };
}

// ── 形态三：匿名 Plugin（无参数）──
const withTimestamps: Plugin = (inner) =>
  async function* (input) {
    const start = Date.now();
    for await (const event of inner(input)) {
      yield event;
      if (event.type === "run:finished") {
        console.log(`Run took ${Date.now() - start}ms`);
      }
    }
  };
```

**两类 Plugin 的本质区别：**

| 类别 | 如何工作 | 代表 | 何时用 |
|------|----------|------|--------|
| **事件观察型** | `for await (e of inner(input))` 包裹 | withLogging, withTimestamps, withTelemetry | 日志、监控、指标 |
| **Input 注入型** | 改写 `input` 后传给 `inner` | withApproval, withPromptGuard | 审批、安全、路由 |

大部分 Plugin 是事件观察型。只有需要介入 agent() 内部决策（在工具执行前做判断）的才用 input 注入型。input 注入型的 Power 更大——它通过 `input.onTools`（即 `OnToolsDecision` 回调）获得**否决能力**。

---

### 5.2 内置 Plugin

agent-v2 提供以下内置 Plugin：

#### withLogging

```typescript
function withLogging(opts: {
  logger: Logger;
  level?: "debug" | "info";
  includeDelta?: boolean;  // 是否记录文本增量（默认 false，避免日志爆炸）
}): Plugin;
```

**功能：** 将所有 AgentEvent 记录到日志系统。

---

#### withRetry

```typescript
function withRetry(opts: {
  /** 最大重试次数，默认 2 */
  maxRetries?: number;
  /** 基础延迟（毫秒），默认 1000 */
  baseDelayMs?: number;
  /** 退避倍数，默认 2（指数退避）*/
  backoffMultiplier?: number;
  /** 最大延迟上限（毫秒），默认 30000 */
  maxDelayMs?: number;
  /** 判断错误是否可重试，默认所有 error-like 事件都可重试 */
  isRetryable?: (event: AgentEvent) => boolean;
}): Plugin;
```

**功能：** 自动重试失败的 LLM 调用。

---

#### withApproval

```typescript
function withApproval(opts: {
  /** 审批函数 */
  approve: (toolCalls: ToolCallInfo[]) => Promise<ApproveDecision>;
}): Plugin;

type ToolCallInfo = {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
};

type ApproveDecision =
  | { action: "allow" }                           // 批准全部
  | { action: "deny"; callIds: string[] }          // 拒绝指定工具
  | { action: "abort"; reason: string }            // 终止运行
  | { action: "pause"; callIds: string[] };         // 暂停等待（详见 §4.5）
```

**功能：** 遇到工具调用时暂停，等待审批。

**工作原理：**

withApproval 是 **input 注入型 Plugin**。它通过设置 `input.onTools` 回调来介入 agent() 内部：

```typescript
function withApproval(opts: { approve: ApproveFn }): Plugin {
  return (inner) =>
    async function* (input) {
      const guardedInput: AgentInput = {
        ...input,
        onTools: async (ctx) => {
          // 情况 A：恢复运行（RunManager 已注入审批结果）
          if (ctx.priorApprovals && ctx.priorApprovals.length > 0) {
            const denied = ctx.priorApprovals.filter(a => a.action === "deny");
            return denied.length > 0
              ? { action: "deny", callIds: denied.map(d => d.callId), reason: "Denied" }
              : { action: "execute" };
          }

          // 情况 B：首次运行，调用外部审批函数
          const result = await opts.approve(ctx.toolCalls);
          switch (result.action) {
            case "allow": return { action: "execute" };
            case "deny":  return { action: "deny", callIds: result.callIds, reason: "Denied" };
            case "abort": return { action: "abort", reason: result.reason };
            case "pause": return { action: "pause", callIds: result.callIds, reason: "Awaiting approval" };
          }
        },
      };
      yield* inner(guardedInput);
    };
}
```

**执行流程：**

```
agent() 内部 → 到达 onTools 注入点
  → 调用 input.onTools(ctx)
  → withApproval 的 onTools: 调用 approve() 函数
  → approve 返回 { action: "allow" }  → onTools 返回 { action: "execute" }
  → approve 返回 { action: "deny" }   → onTools 返回 { action: "deny", ... }
  → approve 返回 { action: "abort" }  → onTools 返回 { action: "abort", ... }
  → approve 返回 { action: "pause" }  → onTools 返回 { action: "pause", ... }
                                         → agent() yield pause:approval + return
                                         → RunManager 保存状态，等待恢复
```

**关键设计：** onTools 内部的 `createToolGuard` 函数处理两种场景——首次运行（调用 approve()）和恢复运行（读取 priorApprovals）。这确保了 agent() 是确定性的（相同 input → 相同行为），因此可以从保存的状态重启。

---

#### withTelemetry

```typescript
function withTelemetry(opts: {
  /** 遥测接收端 */
  sink: TelemetrySink;
}): Plugin;

type TelemetrySink = {
  /** 捕获 spans */
  captureSpan: (span: TelemetrySpan) => void;
  /** 捕获 events */
  captureEvent: (event: TelemetryEvent) => void;
};
```

**功能：** 将 AgentEvent 映射为遥测数据（spans + events）。

**提供的内置 sink：**

- `OpenTelemetrySink` — 输出到 OpenTelemetry
- `ConsoleSink` — 输出到 console（调试用）

---

#### withPromptGuard

```typescript
function withPromptGuard(opts: {
  /** 检测函数，返回 true 表示输入安全 */
  detect: (input: AgentInput) => Promise<boolean>;
  /** 检测到风险时的处理 */
  onBlock: () => Promise<void>;
}): Plugin;
```

**功能：** 在 agent 启动前检测 prompt injection 等安全问题。

---

#### withTimeout

```typescript
function withTimeout(opts: {
  /** 总超时时间（毫秒） */
  durationMs: number;
  /** 超时时是否允许 graceful shutdown */
  graceful?: boolean;
}): Plugin;
```

**功能：** 限制 agent 运行总时长，超时自动取消。

---

#### withStepTimeout

```typescript
function withStepTimeout(opts: {
  /** 单步超时（毫秒） */
  durationMs: number;
}): Plugin;
```

**功能：** 限制单个 ReAct 步骤的时长。

---

#### withMaxTokens

```typescript
function withMaxTokens(opts: {
  /** 累计 token 上限 */
  maxTotalTokens: number;
  /** 达到上限时的行为 */
  onExceeded: "warn" | "stop" | "summarize";
}): Plugin;
```

**功能：** 监控累计 token 用量，防止上下文窗口爆炸。

---

#### withCache

```typescript
function withCache(opts: {
  /** 缓存后端 */
  store: CacheStore;
  /** 缓存键生成策略 */
  keyFn?: (input: AgentInput) => string;
  /** TTL（毫秒） */
  ttlMs?: number;
}): Plugin;

type CacheStore = {
  get: (key: string) => Promise<AgentResult | undefined>;
  set: (key: string, result: AgentResult, ttlMs: number) => Promise<void>;
};
```

**功能：** 缓存 LLM 响应。相同的 system prompt + messages 在 TTL 内直接返回缓存结果。

---

### 5.3 pipe() 组合

`pipe()` 是一个轻量组合函数，将多个 Plugin 和一个 agent 函数串接起来。

```typescript
/**
 * 从左到右组合多个 Plugin 和一个 agent 函数。
 *
 * 执行顺序（数据流向）：
 * input → plugin1 → plugin2 → ... → agent → event stream
 */
function pipe(
  ...plugins: [...Plugin[], (input: AgentInput) => AgentGenerator]
): (input: AgentInput) => AgentGenerator;
```

**使用示例：**

```typescript
import { agent, pipe, withLogging, withRetry, withApproval } from "@renx/agent-v2";

const myAgent = pipe(
  withLogging({ logger: consoleLogger }),
  withRetry({ maxRetries: 3, baseDelayMs: 500 }),
  withApproval({ approve: myApprovalHandler }),
  withPromptGuard({ detect: guardCheck, onBlock: blockHandler }),
  withTimeout({ durationMs: 300_000 }),
  agent
);

// myAgent 现在可以像普通 agent 一样使用
for await (const event of myAgent({
  model: "claude-sonnet-4-20250514",
  systemPrompt: "You are a helpful assistant",
  messages: [{ role: "user", content: "Hello" }],
})) {
  // 事件已经被所有 Plugin 处理过
}
```

**执行顺序：** `withLogging` 最先拦截（最外层），`agent` 最后执行（最内层）。

```
        input
          │
    ┌─────▼─────┐
    │ logging   │ ← 最外层，最先收到 input，最后看到 output
    └─────┬─────┘
    ┌─────▼─────┐
    │ retry     │
    └─────┬─────┘
    ┌─────▼─────┐
    │ approval  │
    └─────┬─────┘
    ┌─────▼─────┐
    │ guard     │
    └─────┬─────┘
    ┌─────▼─────┐
    │ timeout   │
    └─────┬─────┘
    ┌─────▼─────┐
    │ agent     │ ← 最内层，最后收到 input，最先产生 output
    └───────────┘
```

---

### 5.4 多 Agent 协作

agent-v2 提供两种多 agent 协作模式：

1. **Agent as Tool**—一个 agent 被另一个 agent 当作工具调用（类似 delegation）
2. **Handoff**—一个 agent 将控制权完全转移给另一个 agent（类似 escalation）

---

### 5.5 Agent as Tool

```typescript
/**
 * 将一个 agent 函数包装为 Tool。
 * 这样 agent A 可以在执行过程中调用 agent B 来完成子任务。
 */
function agentAsTool(opts: {
  /** 工具名称（LLM 如何称呼这个 agent） */
  name: string;
  /** 工具描述（告诉 LLM 何时调用这个 agent） */
  description: string;
  /** 被包装的 agent 函数 */
  agent: ReturnType<typeof pipe> | typeof agent;
  /**
   * 如何构建子 agent 的 input。
   * @param args - LLM 传入的参数
   * @param parent - 父 agent 的上下文
   */
  buildInput: (
    args: Record<string, unknown>,
    parent: { model: string; workingMemory: Record<string, unknown>; signal: AbortSignal }
  ) => AgentInput;
  /**
   * 子 agent 事件的回调（如需要转发给父 agent 的流）。
   * 默认不转发。
   */
  onChildEvent?: (event: AgentEvent) => void;
  /**
   * 如何将子 agent 的结果映射为工具返回值（字符串）。
   */
  mapResult?: (result: AgentResult) => string;
}): Tool;
```

**使用示例：**

```typescript
// 定义一个研究 agent
const researchAgent = pipe(
  withTools([webSearchTool, fetchPageTool]),
  agent
);

// 定义一个写作 agent
const writerAgent = pipe(
  withTools([
    agentAsTool({
      name: "research",
      description: "Research a topic thoroughly and return findings",
      agent: researchAgent,
      buildInput: (args, parent) => ({
        model: parent.model,
        systemPrompt: "You are a researcher. Find accurate information.",
        messages: [{ role: "user", content: String(args.topic) }],
        tools: [webSearchTool, fetchPageTool],
      }),
    }),
  ]),
  agent
);

// writer 在执行时会自己决定何时调用 "research"
for await (const event of writerAgent({
  model: "claude-sonnet-4-20250514",
  systemPrompt: "You are a writer. Use research() when needed.",
  messages: [{ role: "user", content: "Write an article about quantum computing" }],
})) {
  // 事件来自 writerAgent
  // 子 agent 的事件通过 onChildEvent 可选转发
}
```

**多 Agent 的嵌套示意：**

```
┌────────────────────────────────────────────┐
│  Writer Agent                              │
│                                            │
│  LLM: "I should research quantum           │
│        computing first..."                 │
│                                            │
│  Tool call: research(topic="quantum")      │
│       │                                    │
│       ▼                                    │
│  ┌──────────────────────────────────┐      │
│  │  Research Agent                  │      │
│  │                                  │      │
│  │  LLM → search → fetch → LLM     │      │
│  │  "Here are the findings: ..."    │      │
│  └──────────────────────────────────┘      │
│       │                                    │
│  Tool result: "Quantum computing uses..."  │
│                                            │
│  LLM: "Based on the research, here's       │
│        the article..."                     │
└────────────────────────────────────────────┘
```

---

### 5.6 Handoff

Handoff 不同于 Agent as Tool。Handoff 是**控制权转移**——父 agent 决定自己不直接处理，把整个对话交给另一个 agent。

```typescript
/**
 * 创建一个 handoff 工具。
 * 当 LLM 调用这个工具时，agent 的运行会终止，
 * 控制权传递给 target agent。
 */
function handoff(opts: {
  /** 目标 agent */
  to: ReturnType<typeof pipe> | typeof agent;
  /** 工具名称（LLM 如何称呼这个 handoff） */
  name: string;
  /** 工具描述（告诉 LLM 何时 handoff） */
  description: string;
  /** 过滤要传递给目标 agent 的 messages */
  filterMessages?: (messages: Message[]) => Message[];
}): Tool;
```

**Handoff 的工作方式：**

1. Agent A 运行中，LLM 决定调用 `handoff()`
2. Agent A 终止，控制权交给 Agent B
3. Agent B 接收消息历史，从新 system prompt 开始执行

```typescript
const billingAgent = pipe(withTools([lookupInvoice, refundCharge]), agent);
const supportAgent = pipe(
  withTools([
    faqSearchTool,
    handoff({
      name: "transfer_to_billing",
      to: billingAgent,
      description: "Hand off to the billing department for payment issues",
    }),
  ]),
  agent
);
```

**Handoff 的事件流：**

```
run:started (support agent)
  step:started
    llm:delta ("Let me transfer you to billing...")
    llm:tool-call (transfer_to_billing, {reason: "refund request"})
  step:completed

  // Handoff 事件
  { type: "handoff", from: "support", to: "billing" }

  // 切换到 billing agent
  step:started
    llm:delta ("I see you need a refund...")
    ...
  step:completed
run:finished
```

---

## 6. Layer 4 — 基础设施

### 6.1 RunManager

RunManager 在 agent 生成器之上提供运行生命周期管理。它负责：
- 状态持久化
- 暂停/恢复
- 审批处理
- 历史查询

```typescript
/**
 * 管理一个 agent 运行的完整生命周期。
 */
interface ManagedRun {
  /** 运行标识 */
  runId: string;

  /** 当前状态 */
  status: () => RunState["status"];

  /** 当前完整状态快照 */
  state: () => RunState;

  /**
   * 获取事件流。
   *
   * 注意：stream() 是一个消费者——你可以在不同的时间点多次调用它。
   * 每次调用会从上次消费到的位置继续。
   *
   * 举个例子，处理"暂停-审批-继续"的场景：
   *
   *   // 第一次消费到暂停
   *   for await (const e of run.stream()) {
   *     if (e.type === "pause:approval") break;
   *   }
   *   // 审批后继续
   *   await run.approve(["call_1"]);
   *   for await (const e of run.stream()) {
   *     // 从暂停点之后继续
   *   }
   */
  stream(): AsyncGenerator<AgentEvent, void, void>;

  // ── 控制方法 ──

  /** 批准工具调用 */
  approve(callIds: string[]): Promise<void>;

  /** 拒绝工具调用 */
  deny(callIds: string[]): Promise<void>;

  /** 提供用户输入后恢复运行 */
  provideInput(messages: Message[]): Promise<void>;

  /** 取消运行 */
  cancel(): Promise<void>;

  // ── 查询方法 ──

  /** 获取历史事件 */
  events(): Promise<AgentEvent[]>;
}
```

**RunManager 工厂：**

```typescript
declare const RunManager: {
  /**
   * 创建一个新的 managed run 并立即开始执行。
   */
  create(
    input: AgentInput,
    agent: (input: AgentInput) => AgentGenerator,
    opts?: {
      adapter?: PersistenceAdapter;
    }
  ): ManagedRun;

  /**
   * 从持久化存储中恢复一个 run。
   */
  resume(
    runId: string,
    opts?: {
      agent: (input: AgentInput) => AgentGenerator;
      adapter: PersistenceAdapter;
    }
  ): Promise<ManagedRun>;

  /**
   * 列出所有 runs。
   */
  list(
    filter?: { status?: RunStatus },
    opts?: { adapter: PersistenceAdapter }
  ): Promise<ManagedRun[]>;
};
```

**使用示例：**

```typescript
// 创建并运行
const run = RunManager.create(
  {
    model: "claude-sonnet-4-20250514",
    systemPrompt: "You are a helpful assistant",
    messages: [{ role: "user", content: "Deploy to production?" }],
    tools: [deployTool],
  },
  pipe(withApproval({ approve: humanApprove }), agent),
  { adapter: new PostgresAdapter({ connectionString: "..." }) }
);

// 流式消费
for await (const event of run.stream()) {
  if (event.type === "llm:delta") {
    process.stdout.write(event.delta);
  }
  if (event.type === "pause:approval") {
    // 暂停，等待人工审批
    // 在实际场景中，这里可能是保存 runId 然后退出，
    // 之后再从 RunManager.resume(runId) 恢复
    console.log("\nPending approval for:", event.tools);
    break;
  }
}

// ... 用户审批后 ...
await run.approve(["call_1"]);

// 继续消费
for await (const event of run.stream()) {
  if (event.type === "llm:delta") process.stdout.write(event.delta);
  if (event.type === "run:finished") break;
}
```

**RunManager 的状态管理：**

```
                         RunManager.create()
                               │
                               ▼
                         ┌─────────┐
                         │ running │
                         └────┬────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
         pause:input    pause:approval    run:finished
              │               │               │
              ▼               ▼               ▼
      ┌──────────────┐ ┌──────────────┐  ┌───────────┐
      │waiting_input │ │waiting_approval│ │ completed │
      └──────┬───────┘ └──────┬───────┘  └───────────┘
             │                │
      provideInput()    approve()/deny()
             │                │
             ▼                ▼
         ┌─────────────────────┐
         │      running        │
         └─────────────────────┘
```

---

### 6.2 PersistenceAdapter

PersistenceAdapter 是 RunManager 的存储后端抽象。它只负责两件事：**存 state** 和**存 events**。

```typescript
/**
 * 持久化适配器接口。
 */
interface PersistenceAdapter {
  /** 保存/更新运行状态 */
  saveState(state: RunState): Promise<void>;

  /** 加载运行状态 */
  loadState(runId: string): Promise<RunState | null>;

  /** 追加事件 */
  appendEvents(runId: string, events: AgentEvent[]): Promise<void>;

  /** 获取事件（支持从某个序号之后获取） */
  getEvents(runId: string, opts?: {
    offset?: number;
    limit?: number;
  }): Promise<AgentEvent[]>;

  /** 列出所有运行 */
  listRuns(filter?: { status?: RunStatus }): Promise<RunState[]>;

  /** 删除运行 */
  deleteRun(runId: string): Promise<void>;
}
```

**三种内置实现：**

| 实现 | 适用场景 | 持久化 | 并发安全 |
|------|----------|--------|----------|
| `InMemoryAdapter` | 开发/测试 | 否 | 否 |
| `FileSystemAdapter` | 单机生产 | 是（JSON 文件） | 否 |
| `PostgresAdapter` | 分布式生产 | 是（PostgreSQL） | 是（行锁） |

```typescript
// 内存
const mem = new InMemoryAdapter();

// 文件
const fs = new FileSystemAdapter({ baseDir: "./agent-runs" });

// Postgres
const pg = new PostgresAdapter({
  connectionString: process.env.DATABASE_URL,
  schema: "agent_v2",  // 可选：自定义 schema 名
});
```

---

### 6.3 Worker

Worker 提供分布式消费模式。多个 worker 从一个共享的 PersistenceAdapter 中拉取任务执行。

```typescript
/**
 * Worker 配置。
 */
type WorkerConfig = {
  /** 要执行的 agent 函数 */
  agent: (input: AgentInput) => AgentGenerator;

  /** 共享的持久化适配器 */
  adapter: PersistenceAdapter;

  /** 轮询间隔（毫秒），默认 500 */
  pollIntervalMs?: number;

  /** 每次拉取的任务数，默认 10 */
  batchSize?: number;

  /** 处理的状态过滤，默认 ["ready"] */
  statuses?: RunStatus[];

  /** worker 标识 */
  workerId?: string;

  /** 租约 TTL（毫秒），默认 30000 */
  leaseTtlMs?: number;

  /** 租约续期间隔（毫秒），默认 leaseTtlMs / 2 */
  leaseRenewIntervalMs?: number;
};

/**
 * 创建一个后台 worker。
 */
declare function createWorker(config: WorkerConfig): Worker;

interface Worker {
  /** 启动 worker（返回的 promise 在 stop() 后 resolve） */
  start: (signal?: AbortSignal) => Promise<void>;

  /** 手动执行一次轮询（用于 cron / serverless 场景） */
  poll: () => Promise<void>;

  /** 停止 worker */
  stop: () => void;
}
```

**使用示例：**

```typescript
const worker = createWorker({
  agent: pipe(withLogging({ logger }), withRetry({ maxRetries: 2 }), agent),
  adapter: new PostgresAdapter({ connectionString: process.env.DATABASE_URL }),
  pollIntervalMs: 1000,
  workerId: "worker-3",
});

// 持续运行
await worker.start(AbortSignal.timeout(60_000)); // 60 秒后停止

// 或者：用于 serverless / cron
await worker.poll(); // 处理一批任务后退出
```

**Worker 的 lease 协议（简化版，PostgresAdapter 实现）：**

```
1. Worker 查询状态为 "ready" 且锁定者为空的 runs
2. SELECT ... FOR UPDATE SKIP LOCKED 获取 lease
3. 锁定后更新 locked_by = workerId, locked_at = now()
4. 启动 agent 执行
5. 执行期间定期续约：UPDATE locked_at = now()
6. 完成后释放：locked_by = null, status = "completed"
7. 崩溃后：其他 worker 检测到 locked_at 超时，可以抢占
```

---

### 6.4 遥测

```typescript
/**
 * 遥测数据模型。
 */
type TelemetrySpan = {
  name: string;
  runId: string;
  startTime: number;
  endTime: number;
  parentSpanId?: string;
  attributes: Record<string, string | number | boolean>;
  status: "ok" | "error";
};

type TelemetryEvent = {
  name: string;
  runId: string;
  timestamp: number;
  attributes: Record<string, string | number | boolean>;
};

type TelemetrySink = {
  captureSpan: (span: TelemetrySpan) => void;
  captureEvent: (event: TelemetryEvent) => void;
};
```

**AgentEvent → 遥测映射（由 withTelemetry 插件完成）：**

| AgentEvent | 遥测产物 |
|------------|----------|
| `run:started` | Span: `agent.run` (start) |
| `step:started` | Span: `agent.step` (start, parent=run) |
| `llm:delta` | Event: `llm.token` |
| `llm:done` | Event: `llm.complete` (usage, finishReason) |
| `tool:start` | Span: `tool.call` (start, parent=step) |
| `tool:result` | Span: `tool.call` (end, durationMs) |
| `step:completed` | Span: `agent.step` (end) |
| `run:finished` | Span: `agent.run` (end, totalSteps, totalTokens) |

---

## 7. 目录结构

```
packages/agent-v2/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── DESIGN.md                     # 本文档
│
├── src/
│   ├── index.ts                  # 公开 API 导出
│   │
│   ├── types.ts                  # AgentInput, AgentResult, AgentGenerator
│   ├── state.ts                  # RunState + factory
│   ├── events.ts                 # AgentEvent 联合类型
│   ├── errors.ts                 # AgentError, AgentErrorCode
│   ├── message.ts                # Message, ContentBlock, ToolCall
│   ├── tool.ts                   # Tool, ToolContext, ToolCallInfo
│   ├── llm-client.ts             # LLMClient, LLMChunk, LLMStreamRequest
│   │
│   ├── agent.ts                  # agent() 核心生成器
│   ├── plugin.ts                 # Plugin 类型 + pipe() 组合
│   │
│   ├── plugins/                  # 内置 Plugin
│   │   ├── logging.ts            # withLogging
│   │   ├── retry.ts              # withRetry
│   │   ├── approval.ts           # withApproval
│   │   ├── telemetry.ts          # withTelemetry
│   │   ├── prompt-guard.ts       # withPromptGuard
│   │   ├── timeout.ts            # withTimeout
│   │   ├── step-timeout.ts       # withStepTimeout
│   │   ├── max-tokens.ts         # withMaxTokens
│   │   └── cache.ts              # withCache
│   │
│   ├── multi-agent/              # 多 Agent 协作
│   │   ├── agent-as-tool.ts      # agentAsTool()
│   │   └── handoff.ts            # handoff()
│   │
│   ├── runner/                   # 运行时管理
│   │   ├── manager.ts            # RunManager
│   │   ├── worker.ts             # createWorker
│   │   └── adapters/             # 持久化后端
│   │       ├── adapter.ts        # PersistenceAdapter 接口
│   │       ├── memory.ts         # InMemoryAdapter
│   │       ├── filesystem.ts     # FileSystemAdapter
│   │       └── postgres.ts       # PostgresAdapter
│   │
│   ├── telemetry/                # 遥测
│   │   ├── types.ts              # TelemetrySink, TelemetrySpan, TelemetryEvent
│   │   ├── otel.ts               # OpenTelemetrySink
│   │   └── console.ts            # ConsoleSink
│   │
│   └── utils/                    # 内部工具
│       ├── id.ts                 # nanoid 封装
│       ├── logger.ts             # Logger 类型 + noop/console 实现
│       ├── abort.ts              # AbortSignal 工具
│       └── json-schema.ts        # Zod → JSON Schema 转换
│
├── test/
│   ├── agent.test.ts
│   ├── plugin.test.ts
│   ├── plugins/
│   │   ├── logging.test.ts
│   │   ├── retry.test.ts
│   │   ├── approval.test.ts
│   │   └── cache.test.ts
│   ├── multi-agent/
│   │   ├── agent-as-tool.test.ts
│   │   └── handoff.test.ts
│   ├── runner/
│   │   ├── manager.test.ts
│   │   └── adapters/
│   │       ├── memory.test.ts
│   │       ├── filesystem.test.ts
│   │       └── postgres.test.ts
│   └── fixtures/
│       ├── mock-llm-client.ts    # 可编程的假 LLM client
│       └── mock-tools.ts         # 假工具
│
└── examples/
    ├── basic.ts                  # 最简使用
    ├── streaming.ts              # 流式输出
    ├── with-plugins.ts           # Plugin 组合
    ├── approval.ts               # 人工审批
    ├── multi-agent.ts            # Agent as Tool
    ├── handoff.ts                # Handoff
    └── worker.ts                 # Worker 模式
```

---

## 8. API 速览

### 导入路径

```typescript
// 核心：agent 函数、pipe、所有类型
import { agent, pipe } from "@renx/agent-v2";
import type {
  AgentInput, AgentResult, AgentGenerator, AgentEvent,
  RunState, RunStatus,
  Tool, ToolContext,
  LLMClient, LLMChunk,
  Plugin, Message, AgentError
} from "@renx/agent-v2";

// 内置 Plugin
import {
  withLogging, withRetry, withApproval, withTelemetry,
  withPromptGuard, withTimeout, withStepTimeout,
  withMaxTokens, withCache
} from "@renx/agent-v2/plugins";

// 多 Agent
import { agentAsTool, handoff } from "@renx/agent-v2/multi-agent";

// 运行时管理
import { RunManager, createWorker } from "@renx/agent-v2/runner";

// 持久化适配器
import {
  InMemoryAdapter, FileSystemAdapter, PostgresAdapter
} from "@renx/agent-v2/adapters";

// 遥测
import { OpenTelemetrySink, ConsoleSink } from "@renx/agent-v2/telemetry";
import type { TelemetrySink } from "@renx/agent-v2/telemetry";
```

### 一个完整示例

```typescript
import { agent, pipe } from "@renx/agent-v2";
import { withLogging, withRetry, withApproval, withTimeout } from "@renx/agent-v2/plugins";
import { agentAsTool } from "@renx/agent-v2/multi-agent";
import { RunManager } from "@renx/agent-v2/runner";
import { PostgresAdapter } from "@renx/agent-v2/adapters";
import { OpenTelemetrySink } from "@renx/agent-v2/telemetry";
import { z } from "zod";

// 1. 定义工具
const searchTool = {
  name: "web_search",
  description: "Search the web for information",
  parameters: z.object({ query: z.string() }),
  execute: async ({ query }) => ({ results: await searchAPI(query) }),
};

// 2. 构建 agent（Plugin 组合）
const myAgent = pipe(
  withLogging({ logger: console }),
  withRetry({ maxRetries: 3 }),
  withApproval({ approve: async (calls) => ({ action: "allow" }) }),
  withTimeout({ durationMs: 120_000 }),
  agent
);

// 3. 创建 managed run（带持久化）
const adapter = new PostgresAdapter({
  connectionString: process.env.DATABASE_URL!,
});
const run = RunManager.create(
  {
    model: "claude-sonnet-4-20250514",
    systemPrompt: "You are a helpful assistant with web search.",
    messages: [{ role: "user", content: "What's the latest on Mars missions?" }],
    tools: [searchTool],
    maxSteps: 10,
  },
  myAgent,
  { adapter }
);

// 4. 流式消费
console.log(`[${run.runId}] Started\n`);
for await (const event of run.stream()) {
  switch (event.type) {
    case "llm:delta":
      process.stdout.write(event.delta);
      break;
    case "tool:start":
      console.log(`\n🔧 Calling ${event.name}...`);
      break;
    case "tool:result":
      console.log(`✅ ${event.name} done (${event.durationMs}ms)`);
      break;
    case "run:finished":
      console.log(`\n\nDone in ${event.outcome.totalSteps} steps`);
      console.log(`Tokens: ${event.outcome.tokenUsage.input} → ${event.outcome.tokenUsage.output}`);
      break;
  }
}
```

---

## 9. 与 v1 对比

### 架构对比

| 维度 | v1 (`@renx/agent`) | v2 (`@renx/agent-v2`) |
|------|-------------------|----------------------|
| **核心抽象** | `Agent` 类 | `agent()` 生成器函数 |
| **扩展机制** | `agent.use(hook)` | `pipe(plugin1, plugin2, agent)` |
| **输出方式** | `onStreamChunk` 回调 | `for await (event)` 直接迭代 |
| **组合方式** | 类实例 + 方法链 | 函数组合 (pipe) |
| **多 Agent** | 无 | `agentAsTool()` / `handoff()` |
| **工具管理** | `ToolRegistry` 注册 | 直接传 `Tool[]` 参数 |
| **状态分离** | 混在 `AgentRunRecord` 中 | `workingMemory` 独立于 `messages` |
| **错误处理** | `RuntimeOutcome` ok/fail | `AgentEvent` 中的 error 变体 + `AgentError` |
| **暂停/恢复** | State machine transitions | Plugin 注入 pause 事件 + RunManager 恢复 |
| **Session Store** | 3 种实现 | 重命名为 PersistenceAdapter，接口精简 |
| **Worker** | Lease-based polling | 同上，但简化了 lease 协议 |
| **遥测** | OpenTelemetry Sink | 通用 TelemetrySink + 内置 OTel 和 Console |
| **LLM 重试** | `llmRetry` 配置 | `withRetry` Plugin |
| **工具审批** | `createPermissionHook` | `withApproval` Plugin |
| **可测试性** | 需 mock `AgentRuntime` | 纯函数，传假 LLM client 即可 |

### 类型精简

v1 的类型数量约 **40+** 个独立命名类型。v2 精简到约 **25** 个：

| v1 类型 | v2 对应 |
|---------|---------|
| `AgentConstructorConfig` | `AgentInput` |
| `QueryModelOutcome` | `AgentResult` |
| `AgentHook` | `Plugin` |
| `AgentHookEvent` | `AgentEvent` |
| `AgentRunRecord` | `RunState` |
| `AgentSessionStore` | `PersistenceAdapter` |
| `AgentRuntime` | 不存在了（被 agent() + RunManager 取代） |
| `RunStateMachine` | 不存在了（被 RunManager 内部状态替代） |
| `Harness` | 不存在了（被 agent() 内部实现替代） |
| `ReActLoopEngine` | 不存在了（被 agent() 内部实现替代） |
| `ToolCallProcessor` | 不存在了（被 agent() 内部实现替代） |
| `ToolRegistry` | 不存在了（直接传 `Tool[]`） |
| `SandboxRegistry` | 不存在了（由 RunManager 或 Plugin 实现） |
| `QueryModelType` | `LLMStreamRequest` |
| `RuntimeOutcome` | 不存在了（错误通过 `LLMChunk` 和 `AgentError` 处理） |

### API 使用对比

**v1:**

```typescript
const agent = new Agent({
  maxSteps: 8,
  llmRetry: { maxRetries: 2 },
  sessionStore: new PostgresSessionStore({ connectionString: "..." }),
});

agent.use(
  createPermissionHook({ /* ... */ }),
  createAuditHook({ /* ... */ }),
);

const outcome = await agent.run({
  systemPrompt: "...",
  messages: [{ role: "user", content: "..." }],
  model: "gpt-4o",
});
```

**v2:**

```typescript
const myAgent = pipe(
  withRetry({ maxRetries: 2 }),
  withApproval({ approve: /* ... */ }),
  withTelemetry({ sink: /* ... */ }),
  agent
);

const run = RunManager.create(input, myAgent, {
  adapter: new PostgresAdapter({ connectionString: "..." }),
});

for await (const event of run.stream()) { /* ... */ }
```

**代码量对比（典型场景）：**

| 场景 | v1 行数 | v2 行数 |
|------|---------|---------|
| 最简运行 | ~8 行 | ~6 行 |
| 带工具 + 流式输出 | ~15 行 | ~12 行 |
| 带审批 + 持久化 + 遥测 | ~30 行 | ~20 行 |
| 多 Agent 协作 | 不可直接实现 | ~25 行 |

---

## 10. 迁移指南

### 从 v1 迁移到 v2 的对照表

v1 组件 → v2 替代方案：

| v1 概念 | v2 替代 | 说明 |
|---------|---------|------|
| `new Agent(config)` | `pipe(plugins..., agent)` | Agent 不再是类 |
| `agent.use(hook)` | `pipe(plugin, ...)` | Plugin 组合 |
| `agent.run(params)` | `for await (e of agent(input))` | 直接迭代 |
| `agent.createRun()` | `RunManager.create()` | Managed run |
| `agent.startRun(id)` | RunManager 自动启动 | 不需要手动 start |
| `agent.resumeRun(id, input)` | `RunManager.resume(id)` + `provideInput()` | 恢复运行 |
| `createPermissionHook()` | `withApproval()` Plugin | 审批 |
| `createAuditHook()` | `withTelemetry()` Plugin | 审计 |
| `createLoggingHook()` | `withLogging()` Plugin | 日志 |
| `createDefaultRunProfile()` | 不需要 | input 直接传 |
| `createStreamRecorder()` | 不需要 | event stream 自然可记录 |
| `ToolRegistry` | `Tool[]` 参数 | 不需要注册 |
| `AgentSessionStore` | `PersistenceAdapter` | 接口精简 |
| `InMemorySessionStore` | `InMemoryAdapter` | 重命名 |
| `FileSessionStore` | `FileSystemAdapter` | 重命名 |
| `PostgresSessionStore` | `PostgresAdapter` | 重命名 |
| `AgentWorker` | `createWorker()` | 函数式 |
| `AgentRuntime` | `agent()` | 函数式 |
| `SandboxRegistry` | Plugin 层实现 | 不再内置 |
| `RunStateMachine` | RunManager 内部 | 不再暴露 |
| `ReActLoopEngine` | agent() 内部 | 不再暴露 |
| `LlmRetryConfig` | `withRetry({ ... })` | Plugin 化 |

---

## 11. 实现路线图

### Phase 1: 核心（最优先）

目标：能够运行一个基本的 ReAct agent。

- [ ] `src/types.ts` — `AgentInput`, `AgentResult`, `AgentGenerator`
- [ ] `src/state.ts` — `RunState` + 工厂函数
- [ ] `src/events.ts` — `AgentEvent` 联合类型
- [ ] `src/errors.ts` — `AgentError`, `AgentErrorCode`
- [ ] `src/message.ts` — `Message` 系列类型
- [ ] `src/tool.ts` — `Tool`, `ToolContext`
- [ ] `src/llm-client.ts` — `LLMClient`, `LLMChunk`, `LLMStreamRequest`
- [ ] `src/agent.ts` — `agent()` 核心生成器
- [ ] `src/plugin.ts` — `Plugin` 类型 + `pipe()` 组合函数
- [ ] `test/fixtures/mock-llm-client.ts` — 可编程的假 LLM 客户端
- [ ] `test/fixtures/mock-tools.ts` — 假工具
- [ ] `test/agent.test.ts` — agent 核心测试
- [ ] `test/plugin.test.ts` — pipe/plugin 测试

**验收标准：**

```typescript
// 能运行
let result: AgentResult | undefined;
const gen = agent({
  model: "test-model",
  systemPrompt: "You are a helpful assistant",
  messages: [{ role: "user", content: "Hi" }],
});
for await (const event of gen) {
  if (event.type === "run:finished") {
    result = event.outcome;
  }
}
console.log(result.text);
```

### Phase 2: 内置 Plugin

目标：提供生产就绪的 Plugin 集合。

- [ ] `src/plugins/logging.ts`
- [ ] `src/plugins/retry.ts`
- [ ] `src/plugins/approval.ts`
- [ ] `src/plugins/timeout.ts`
- [ ] `src/plugins/step-timeout.ts`
- [ ] `src/plugins/max-tokens.ts`
- [ ] `src/plugins/prompt-guard.ts`
- [ ] `src/plugins/cache.ts`
- [ ] 每个 Plugin 的单元测试

### Phase 3: 运行时管理

目标：持久化、暂停/恢复、分布式 worker。

- [ ] `src/runner/adapters/adapter.ts` — `PersistenceAdapter` 接口
- [ ] `src/runner/adapters/memory.ts`
- [ ] `src/runner/adapters/filesystem.ts`
- [ ] `src/runner/adapters/postgres.ts`
- [ ] `src/runner/manager.ts` — `RunManager`
- [ ] `src/runner/worker.ts` — `createWorker`
- [ ] 适配器和 RunManager 的单元测试

### Phase 4: 多 Agent 协作

目标：agent as tool 和 handoff。

- [ ] `src/multi-agent/agent-as-tool.ts`
- [ ] `src/multi-agent/handoff.ts`
- [ ] 单元测试和集成测试

### Phase 5: 遥测

目标：Observability。

- [ ] `src/telemetry/types.ts`
- [ ] `src/telemetry/otel.ts` — OpenTelemetry Sink
- [ ] `src/telemetry/console.ts` — Console Sink
- [ ] `src/plugins/telemetry.ts` — withTelemetry Plugin
- [ ] 单元测试

### Phase 6: 示例和文档

- [ ] `examples/basic.ts`
- [ ] `examples/streaming.ts`
- [ ] `examples/with-plugins.ts`
- [ ] `examples/approval.ts`
- [ ] `examples/multi-agent.ts`
- [ ] `examples/handoff.ts`
- [ ] `examples/worker.ts`
- [ ] 更新 `src/index.ts` 导出所有公共 API

### Phase 7: v1 兼容层（可选）

如果需要渐进迁移，可以提供一层薄兼容：

- [ ] `src/compat/agent.ts` — v1 Agent 接口的 adapter
- [ ] `src/compat/hooks.ts` — v1 Hook 到 v2 Plugin 的转换器

---

## 附录 A: 类型一览

```
AgentInput           → 输入参数（含 onTools 注入点、toolExecution）
AgentResult          → 运行结果
AgentGenerator       → AsyncGenerator<AgentEvent, void, void>

RunState             → 运行状态快照
RunStatus            → "ready" | "running" | "waiting_input" | "waiting_approval" | "completed" | "failed" | "cancelled"

OnToolsContext       → onTools 回调上下文（toolCalls, state, priorApprovals）
OnToolsDecision      → execute | deny | abort | pause 四种动作
InternalRunContext   → 内部类型（resumeApprovals），不暴露给用户

Message              → SystemMessage | UserMessage | AssistantMessage | ToolMessage
ContentBlock         → text | image | tool_result
ToolCall             → { id, name, arguments }

Tool<I,O>            → 工具定义
ToolContext          → 工具执行上下文
ToolCallInfo         → 工具调用信息

LLMClient            → LLM 客户端接口
LLMStreamRequest     → LLM 请求
LLMChunk             → text-delta | tool-call-delta | finish | error
LLMStreamGenerator   → AsyncGenerator<LLMChunk>
CanonicalToolSchema  → 传给 LLM 的工具 schema

AgentEvent           → 14 种事件的联合类型（含 handoff）
AgentError           → 错误信息
AgentErrorCode       → 错误码枚举
HandoffInfo          → handoff 目标信息
HandoffSignal        → handoff 控制流信号（内部使用）

Plugin               → (AgentFn) → AgentFn 的高阶函数
Pipe                 → 组合函数

ManagedRun           → 托管运行接口
PersistenceAdapter   → 持久化后端接口（含 lease 方法）

Worker               → worker 实例
WorkerConfig         → worker 配置

TelemetrySink        → 遥测接收端
TelemetrySpan        → 遥测 span
TelemetryEvent       → 遥测 event

ApproveDecision      → 审批决定
CacheStore           → 缓存后端
Logger               → 日志接口
```

## 附录 B: 事件流完整示例

```
假设: systemPrompt = "You are an assistant with a weather tool"
      messages = [{role: "user", content: "What's the weather in Tokyo?"}]
      tools = [get_weather]

Event stream:

1. { type: "run:started",
     runId: "abc123", model: "claude-sonnet-4-20250514",
     tools: ["get_weather"], maxSteps: 10 }

2. { type: "step:started", step: 1 }

3. { type: "llm:delta", step: 1, delta: "Let" }
4. { type: "llm:delta", step: 1, delta: " me" }
5. { type: "llm:delta", step: 1, delta: " check" }
6. { type: "llm:delta", step: 1, delta: " the" }
7. { type: "llm:delta", step: 1, delta: " weather" }
8. { type: "llm:delta", step: 1, delta: " for" }
9. { type: "llm:delta", step: 1, delta: " Tokyo." }

10. { type: "llm:tool-call", step: 1, id: "call_001",
      name: "get_weather", arguments: { location: "Tokyo" } }

11. { type: "llm:done", step: 1, finishReason: "tool_calls",
      text: "Let me check the weather for Tokyo.",
      usage: { input: 120, output: 45 } }

12. { type: "tool:start", callId: "call_001",
      name: "get_weather", arguments: { location: "Tokyo" } }

13. { type: "tool:result", callId: "call_001", ok: true,
      output: { temperature: 22, condition: "sunny" },
      durationMs: 125 }

14. { type: "step:completed", step: 1,
      finishReason: "tool_calls",
      tokenUsage: { input: 120, output: 45 } }

15. { type: "step:started", step: 2 }

16. { type: "llm:delta", step: 2, delta: "The" }
17. { type: "llm:delta", step: 2, delta: " weather" }
18. { type: "llm:delta", step: 2, delta: " in" }
19. { type: "llm:delta", step: 2, delta: " Tokyo" }
20. { type: "llm:delta", step: 2, delta: " is" }
21. { type: "llm:delta", step: 2, delta: " sunny" }
22. { type: "llm:delta", step: 2, delta: " and" }
23. { type: "llm:delta", step: 2, delta: " 22°C." }
24. { type: "llm:done", step: 2, finishReason: "stop",
      text: "The weather in Tokyo is sunny and 22°C.",
      usage: { input: 200, output: 30 } }

25. { type: "step:completed", step: 2,
      finishReason: "stop",
      tokenUsage: { input: 200, output: 30 } }

26. { type: "run:finished",
      outcome: {
        runId: "abc123",
        text: "The weather in Tokyo is sunny and 22°C.",
        messages: [user, assistant(tool_calls), tool_result, assistant(text)],
        workingMemory: {},
        tokenUsage: { input: 320, output: 75 },
        finishReason: "stop",
        totalSteps: 2
      } }
```

---

## 附录 C: 实施关键问题补充 (Implementation Clarifications)

本章节补充正文中定义模糊、矛盾的细节，确保实施时不阻塞。

---

### C.1 AsyncGenerator 的 return value 访问模式

**正文的问题：**

正文 "使用方式一" 示例存在缺陷：

```typescript
for await (const event of gen) { }  // 消费完了
const result = await gen;           // ❌ 已经完成，无法再 await
```

JavaScript 中，`for await` 消费完毕后 generator 已经 `done`，不能再 `await` 获取 return 值。

**正确的 API 设计：**

有两种选择，我们选择**方案 A**：

**方案 A（推荐）：只通过 `run:finished` 事件获取结果**

```typescript
let result: AgentResult | undefined;

for await (const event of agent(input)) {
  if (event.type === "llm:delta") process.stdout.write(event.delta);
  if (event.type === "run:finished") {
    result = event.outcome; // 在事件中捕获结果
    break;
  }
}

console.log(result.text);
```

不再需要 `await gen`。`run:finished` 事件即为结果通知。

**方案 B（备选）：两个独立迭代器**

```typescript
// 如果同时需要流式事件和最终结果
const gen = agent(input);
let result: AgentResult | undefined;

for await (const event of gen) {
  if (event.type === "run:finished") {
    result = event.outcome;
    // 不需要 break，事件取完后自动结束
  }
}
// gen 此时 done，result 已赋值
```

**结论：实现采用方案 A。`agent()` 的 return type 改为 `AsyncGenerator<AgentEvent, void, void>`，即 return 类型为 `void`，结果完全通过 `run:finished` 事件传递。**

修改后的类型：

```typescript
type AgentGenerator = AsyncGenerator<AgentEvent, void, void>;
```

---

### C.2 流式 Tool Call 的 argsDelta 累积算法

这是实施中最棘手的部分之一。LLM provider 流式返回 tool calls 时，每个 tool call 的 args JSON 是通过多个 `tool-call-delta` chunk 逐段送达的，agent 内部需要将其从增量字符串攒成完整 JSON 再解析。

**数据结构：**

```typescript
/**
 * 流式 tool call 累积器的内部状态。
 * - key: tool call id (LLM 分配的，在整个流式响应中唯一)
 * - value: 该 tool call 的累积状态
 */
type ToolCallAccumulator = Map<string, {
  name: string;        // tool call name（第一个 delta 设置）
  argsBuffer: string;  // 累积的 JSON 参数字符串
  complete: boolean;   // 是否已收到完整的 JSON（由 finish 信号标记）
}>;
```

**算法：**

```
function accumulateToolCall(
  acc: ToolCallAccumulator,
  delta: LLMToolCallDeltaChunk
): void {
  let entry = acc.get(delta.id);
  if (!entry) {
    entry = { name: delta.name, argsBuffer: "", complete: false };
    acc.set(delta.id, entry);
  }
  // 只有 name 在第一个 delta 中有效，后续 delta 的 name 可能为空或重复
  if (delta.name && !entry.name) {
    entry.name = delta.name;
  }
  entry.argsBuffer += delta.argsDelta;
}

function finalizeToolCall(
  acc: ToolCallAccumulator,
  id: string
): { name: string; arguments: Record<string, unknown> } | null {
  const entry = acc.get(id);
  if (!entry) return null;
  entry.complete = true;
  try {
    const parsed = JSON.parse(entry.argsBuffer);
    return { name: entry.name, arguments: parsed };
  } catch {
    // JSON 不完整或无效 → 返回 null，agent 层处理为 tool error
    return null;
  }
}
```

**何时认为一个 tool call 完成：**

- **收到 `finish` chunk 时**：这意味着 LLM 已经完成所有输出。此时对 accumulator 中所有尚未 finalize 的 entry 调用 `finalizeToolCall()`。
- **单个 provider 的特殊行为**：某些 provider（如 Anthropic）会在流中发出一个包含完整 tool_use JSON 的 chunk。此时可以通过解析 `argsBuffer` 的完整性决定是否提前 emit。
- **通用策略**：仅在 `finish` chunk 时 finalize 所有 tool calls。这最大程度兼容各种 provider。

**在 agent() 循环中的集成：**

```
chunks ← []
acc ← new Map()

for each chunk from llmClient.stream(request):
  switch chunk.type:
    case "text-delta":
      yield { type: "llm:delta", ... }
    case "tool-call-delta":
      accumulateToolCall(acc, chunk)
    case "finish":
      // 1. 先 finalize 所有 tool calls
      for each [id, _] of acc:
        parsed ← finalizeToolCall(acc, id)
        if parsed:
          yield { type: "llm:tool-call", id, ...parsed }
      // 2. 再 yield llm:done
      yield { type: "llm:done", finishReason, usage, text }
      break
```

**注意：`llm:tool-call` 事件的产出顺序。**
工具调用事件必须在 `llm:done` **之前**产出，因为从事件流角度，`llm:done` 意味着本轮 LLM 调用结束。同时，tool call 的 yield 发生在 `finish` chunk 处理阶段，而不是在 `tool-call-delta` 阶段。

---

### C.3 AgentInput 的 runId 生成

**正文的矛盾：**

- `AgentInput` 类型中没有 `runId` 字段
- `RunState` 有 `runId` 字段
- 事件 `run:started` 产出 `runId`

**明确：**

```typescript
type AgentInput = {
  // 新增字段：
  /** 运行标识。调用方传入则使用，否则 agent() 内部自动生成 */
  runId?: string;

  model: string;
  systemPrompt: string;
  messages: Message[];
  tools?: Tool[];
  maxSteps?: number;       // 默认 10
  llmClient?: LLMClient;
  workingMemory?: Record<string, unknown>;
  signal?: AbortSignal;
};
```

`agent()` 内部：

```typescript
const runId = input.runId ?? generateId();
```

这样调用方可以指定 runId（用于关联外部系统），也可以留空让 agent 生成。

---

### C.4 `agent()` 内部 Tool 执行：顺序 vs 并发

**正文的伪代码使用 `for each toolCall`（顺序执行）。**

**明确策略：**

v2 默认**并发**执行所有 tool calls（因为它们之间通常没有依赖）。但如果用户需要顺序执行（例如有写入工具需要先完成），通过 `AgentInput.toolExecution` 控制。

**并发执行的实现（正确版本）：**

⚠️ **重要：不能在 `Promise.allSettled` 的回调中直接 `yield`**。`.map()` 回调里的 `async` 函数不是 generator，`yield` 语法在 async 函数中无效。正确的做法是将 "emit 事件" 和 "执行" 分两个阶段：

```typescript
// === 阶段 3a: 先 emit 所有 tool:start 事件 ===
for (const tc of toolCalls) {
  const tool = toolsMap.get(tc.name);
  if (!tool) {
    yield { type: "tool:error", callId: tc.id, error: "Tool not found" };
    notFoundCalls.add(tc.id);
    continue;
  }
  yield { type: "tool:start", callId: tc.id, name: tc.name, arguments: tc.args };
  validCalls.push({ tc, tool });
}

// === 阶段 3b: 并发执行（无 yield inside .map()） ===
if (input.toolExecution !== "sequential") {
  const settled = await Promise.allSettled(
    validCalls.map(({ tc, tool }) =>
      executeSingleTool(tool, tc, {
        runId: state.runId,
        workingMemory: state.workingMemory,
        signal: input.signal,
      })
    )
  );

  // 按顺序 emit 结果
  for (let i = 0; i < validCalls.length; i++) {
    const result = settled[i];
    const { tc } = validCalls[i];
    if (result.status === "fulfilled") {
      const { output, durationMs } = result.value;
      yield { type: "tool:result", callId: tc.id, ok: true, output, durationMs };
      appendToolResultMessage(state, tc, stringify(output));
    } else {
      const errorMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      yield { type: "tool:error", callId: tc.id, error: errorMsg };
      appendToolErrorMessage(state, tc, errorMsg);
    }
  }
}

// === 阶段 3c: 顺序执行 ===
else {
  for (const { tc, tool } of validCalls) {
    try {
      const start = Date.now();
      const output = await tool.execute(tc.args, {
        runId: state.runId,
        workingMemory: state.workingMemory,
        signal: input.signal,
      });
      const durationMs = Date.now() - start;
      yield { type: "tool:result", callId: tc.id, ok: true, output, durationMs };
      appendToolResultMessage(state, tc, stringify(output));
    } catch (error) {
      if (error instanceof HandoffSignal) {
        yield { type: "handoff", from: state.runId, to: error.targetName, reason: error.reason };
        return { ...buildPartialResult(state), finishReason: "handoff", handoff: { ... } };
      }
      const errorMsg = error instanceof Error ? error.message : String(error);
      yield { type: "tool:error", callId: tc.id, error: errorMsg };
      appendToolErrorMessage(state, tc, errorMsg);
    }
  }
}

// === 内部辅助函数（无 yield） ===
async function executeSingleTool(
  tool: Tool,
  tc: ToolCall,
  ctx: ToolContext,
): Promise<{ callId: string; ok: true; output: unknown; durationMs: number }> {
  const start = Date.now();
  const output = await tool.execute(tc.args, ctx);
  const durationMs = Date.now() - start;
  return { callId: tc.id, ok: true, output, durationMs };
}
```

**两种执行模式（通过 `AgentInput` 控制）：**

```typescript
type AgentInput = {
  // ... 其他字段
  /** 工具执行模式。默认 "parallel" */
  toolExecution?: "parallel" | "sequential";
};
```

- `"parallel"`（默认）：`Promise.allSettled`，所有 tool calls 同时执行
- `"sequential"`：`for...of` 逐个执行（当一个工具的输出依赖前一个工具时使用）

---

### C.5 withApproval Plugin 的具体工作机制

**正文的问题：**

Plugin 只能包裹 `inner(input)` 返回的 generator，它可以在事件通过时拦截，但**无法在 agent 内部"暂停 and 注入批准决策"**，因为 agent() 不感知 Plugin 的存在。

**解决方案：onTools 注入点 + InternalRunContext**

将 Plugin 的介入位置从"拦截事件"改为"注入 input.onTools 回调"。agent() 在工具执行前调用此回调，Plugin 通过返回值控制行为。

**完整的暂停-恢复流程：**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
第一次运行
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

用户调用: run = RunManager.create(input, myAgent)

withApproval 改写 input:
  input = { ...originalInput, onTools: createToolGuard(approve) }

agent() 内部:
  第 1 步: LLM 返回 tool_calls = [deploy_prod]

  执行工具前: input.onTools({
    toolCalls: [deploy_prod],
    state,
    priorApprovals: undefined  ← 首次运行
  })

  createToolGuard 的逻辑:
    priorApprovals === undefined → 进入 "首次运行" 分支
    调用 approve([deploy_prod])
    approve 返回 { action: "pause" }
    → onTools 返回 { action: "pause", callIds: ["call_001"], reason: "Needs approval" }

  agent 收到 pause 决策:
    yield { type: "pause:approval", runId, callIds: ["call_001"], ... }
    return  ← 生成器终止

RunManager 检测到 pause:approval:
  1. adapter.saveState(state)
  2. 状态标记为 waiting_approval

用户的 for-await 循环:
  看到 pause:approval 事件 → break

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
用户审批
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

run.approve(["call_001"])

RunManager:
  1. state = adapter.loadState(runId)
  2. newInput = stateToInput(state)
  3. resumeCtx = { resumeApprovals: [{ callId: "call_001", action: "allow" }] }
  4. 重新调用 myAgent(newInput, resumeCtx)

withApproval 处理 newInput:
  再次注入 onTools（包含 createToolGuard）

agent 重新执行:
  从 state 恢复 → 到达同一个工具调用点

  执行工具前: input.onTools({
    toolCalls: [deploy_prod],
    state,
    priorApprovals: [{ callId: "call_001", action: "allow" }]
  })

  createToolGuard 的逻辑:
    priorApprovals 有值 → 进入 "恢复" 分支
    没有 denied → 返回 { action: "execute" }

  agent 收到 execute:
    执行 deploy_prod → 继续运行
```

**关键词：**

- `onTools` 是 Plugin 写、agent() 读。
- `priorApprovals`（通过 `InternalRunContext.resumeApprovals` 注入到 `OnToolsContext`）是 RunManager 写、onTools 内部的 guard 函数读。
- `InternalRunContext` 不在 `AgentInput` 公开签名中，只在 agent() 内部实现中使用。
- agent() 是确定性的（相同 input → 相同行为），因此从保存的状态重启是安全的。

---

### C.6 Handoff 的内部实现

**正文的问题：**

Handoff 创建了一个 `Tool`，但当 LLM 调用它时，agent() 需要能够识别这是一个 handoff 工具并停止当前运行，而不是把 tool result 返回给 LLM。

**解决方案：** Handoff tool 通过抛出一个特殊的 `HandoffSignal` 来终止 agent() 循环。

```typescript
/**
 * Handoff 信号。
 * 不是真正的异常，而是控制流机制。agent() 内部捕获此信号。
 */
class HandoffSignal {
  constructor(
    public target: (input: AgentInput) => AgentGenerator,
    public messages: Message[],
    public reason: string
  ) {}
}
```

**handoff() 工厂实现：**

```typescript
function handoff(opts: {
  to: (input: AgentInput) => AgentGenerator;
  name: string;
  description: string;
  filterMessages?: (messages: Message[]) => Message[];
}): Tool {
  return {
    name: opts.name,
    description: opts.description,
    parameters: z.object({ reason: z.string(), context: z.string().optional() }),
    async execute(_args, ctx) {
      throw new HandoffSignal(
        opts.to,
        opts.filterMessages ? opts.filterMessages(ctx.workingMemory._messages as Message[]) : [],
        _args.reason
      );
    },
  };
}
```

**agent() 内部集成：**

```
// 在工具执行阶段

try:
  result ← tool.execute(args, ctx)
  // 正常结果...
catch (error):
  if error instanceof HandoffSignal:
    // 产出 handoff 事件并终止
    yield { type: "handoff", from: state.runId, to: error.target.name, reason: error.reason }
    // 返回部分结果（标记 handoff 发生）
    return {
      ...buildPartialResult(state),
      finishReason: "handoff",
      handoff: { target: error.target, messages: error.messages }
    }
  else:
    // 普通错误处理
    yield { type: "tool:error", ... }
```

**AgentResult 增加 handoff 信息：**

```typescript
type AgentResult = {
  // ... 现有字段
  finishReason: string;
  /** 如果 finishReason === "handoff"，此项非空 */
  handoff?: {
    target: (input: AgentInput) => AgentGenerator;
    messages: Message[];
  };
};
```

**新增 AgentEvent：**

```typescript
type AgentEvent =
  | /* ... 现有事件 ... */
  | HandoffEvent;

type HandoffEvent = {
  type: "handoff";
  from: string;
  to: string;
  reason: string;
};
```

---

### C.7 RunManager.stream() 的多次消费实现

**正文的问题：**

AsyncGenerator 天然是一次性的——被 `for await` 消费完毕后不能再消费。但 RunManager 的设计要求 `stream()` 支持暂停-恢复（多次调用）。

**解决方案：** RunManager 内部使用一个可重启的生成器，每次 `stream()` 返回一个"从当前位置继续"的新迭代器，而非同一个物理迭代器。

**内部机制：**

```typescript
class RunManagerImpl implements ManagedRun {
  private _agentFn: (input: AgentInput) => AgentGenerator;
  private _currentGen: AgentGenerator | null = null;
  private _state: RunState;
  private _resumeApprovals: { callId: string; action: "allow" | "deny" }[] | null = null;

  // 公开签名只接受 AgentInput，内部通过 InternalRunContext 注入恢复数据
  private async _startOrResumeAgent(): Promise<void> {
    const input = this._buildInputFromState(this._state);
    const ctx: InternalRunContext = this._resumeApprovals
      ? { resumeApprovals: this._resumeApprovals }
      : {};

    // agent() 内部实现接受 (AgentInput & InternalRunContext)
    // 公开签名 void，通过事件流消费
    this._currentGen = this._agentFn(input);  // resume approvals 通过 onTools context 传递
  }

  async *stream(): AsyncGenerator<AgentEvent, void, void> {
    // ⚠️ 使用 while(true) 而非递归 yield*，避免多次暂停-恢复导致栈溢出
    while (true) {
      if (!this._currentGen) {
        await this._startOrResumeAgent();
      }

      for await (const event of this._currentGen) {
        yield event;
        await this._persistEvent(event);

        if (this._shouldPause(event)) {
          await this._persistState(this._state);
          this._currentGen = null;  // 标记为已终止，下次 stream() 调用会重启
          return;                    // 返回给调用方，等待 resume 操作
        }

        if (event.type === "run:finished") {
          this._currentGen = null;
          await this._persistState(this._state);
          return;
        }
      }

      // Generator 自然结束（异常情况），重置
      this._currentGen = null;
      return;
    }
  }

  async approve(callIds: string[]): Promise<void> {
    this._resumeApprovals = callIds.map(id => ({ callId: id, action: "allow" }));
    // 注意：这里不重新构建 input，不重新调用 agent()
    // 下一次 stream() 调用时，_startOrResumeAgent() 会读取 _resumeApprovals
  }

  async deny(callIds: string[]): Promise<void> {
    this._resumeApprovals = callIds.map(id => ({ callId: id, action: "deny" }));
  }

  private _shouldPause(event: AgentEvent): boolean {
    return event.type === "pause:approval" || event.type === "pause:input";
  }
}
```

**关键点：**

1. `stream()` 返回的始终是一个全新的 `AsyncGenerator`（每次调用都是一个独立的 `async function*`）
2. RunManager 内部维护 `_currentGen`——如果它还有值，说明有未完成的消费
3. 每次 yield 事件时，立即通过 adapter 持久化（`appendEvents`）
4. 当检测到暂停事件时，消费循环主动 `return`，RunManager 保存状态，将 `_currentGen` 设为 null
5. 恢复时（`approve`/`deny`/`provideInput`），RunManager 记录审批决策，下一次 `stream()` 调用时重建 input 和 generator
6. 使用 `while(true)` 循环而非递归 `yield*`——多个暂停-恢复周期不会累积调用栈

**持久化的粒度：**

- 每个事件（llm:delta, tool:start, tool:result, ...）产出后立即写入 adapter
- 这确保了即使进程崩溃，事件不会丢失
- 恢复时通过 `adapter.loadState(runId)` 获取最新状态（messages, stepCount 等）

---

### C.8 workingMemory 的不可变语义

**正文的矛盾：**

文档声明 RunState 不可变，但 `Tool.execute` 通过 `ctx.workingMemory` 获取的是 `Record<string, unknown>` 引用，工具可以直接 `ctx.workingMemory.foo = "bar"` 来修改它。

**解决方案：** 接受 workingMemory 是可变的——它是 agent 内部的"草稿纸"，不是持久化的状态。RunState 的 `workingMemory` 字段在每次持久化时做浅拷贝。

```typescript
// 工具对 workingMemory 的修改是允许的
tool.execute(args, ctx) {
  ctx.workingMemory.foundFiles = ["a.txt", "b.txt"]; // ✅ 允许
}

// 持久化时做浅拷贝
await adapter.saveState({
  ...state,
  workingMemory: { ...state.workingMemory },  // 浅拷贝
});
```

**正式表述修正：**
- `RunState` 整体是"external snapshot"——外界看到的是不可变的
- `workingMemory` 内部是可变的——工具、内部逻辑可以直接修改
- 持久化时对 `workingMemory` 做浅拷贝保护

---

### C.9 withRetry Plugin 与 agent() 内部错误处理的职责划分

**正文的冲突：**

- §4.3 伪代码中 `agent()` 收到 `error` chunk 时直接 `throw chunk.error`
- `withRetry` Plugin 期望捕获 LLM 错误并重试
- 但 agent() 在遇到错误后抛出异常，整个 generator 崩溃，withRetry 如何重试？

**解决方案：** agent() **绝不 throw**。错误通过事件流传播。

修改 agent() 内部的 LLM 错误处理：

```
chunk ← from llmClient.stream(request)

case "error":
  // 不 throw，产出 llm:done 标记为 error
  yield { type: "llm:done", step, finishReason: "error", error: chunk.error, ... }
  // 本轮调用结束，不继续处理
  done = true
  break
```

**withRetry Plugin 的逻辑：**

```typescript
function withRetry(opts: RetryConfig): Plugin {
  return (inner) =>
    async function* (input) {
      let attempt = 0;
      while (attempt < (opts.maxRetries ?? 2) + 1) {
        attempt++;
        const events = [];
        let lastDone: LLMDoneEvent | null = null;

        const gen = inner(input);
        for await (const event of gen) {
          if (event.type === "llm:done") {
            lastDone = event;
            // 如果是 error finishReason 且可重试，break 消费
            if (event.finishReason === "error" && opts.isRetryable?.(event) !== false) {
              events.push(event); // 保留事件但不 yield
              break; // 准备重试
            }
          }
          events.push(event);
          yield event; // 正常事件直接转发
        }

        if (!lastDone || lastDone.finishReason !== "error" || !opts.isRetryable?.(lastDone)) {
          // 不是可重试的错误 → 正常返回
          return;
        }

        // 可重试 → 等待后进入下一轮
        if (attempt <= opts.maxRetries) {
          await sleep(computeDelay(attempt, opts));
          // 调整 input 后重新进入 while 循环（主要是更新 signal、workingMemory）
          continue;
        }

        // 已达到最大重试次数 → 转发所有未 yield 的事件（包括错误）
        for (const e of events) yield e;
        return;
      }
    };
}
```

**关键设计变更：**
1. agent() 不 throw——错误通过 `llm:done(finishReason: "error")` 传递
2. withRetry 监听 `llm:done` 事件决定是否重试
3. 如果重试，Plugin 丢弃该轮已收集的事件，重新调用 `inner(input)`

---

### C.10 Tool → CanonicalToolSchema 转换

```typescript
import { zodToJsonSchema } from "zod-to-json-schema";

function toolToCanonical(tool: Tool): CanonicalToolSchema {
  const jsonSchema = zodToJsonSchema(tool.parameters, {
    $refStrategy: "none",  // 避免 $ref，确保 LLM 兼容
  });

  // zodToJsonSchema 返回带有 $schema 和多余字段的对象
  // 提取纯净的 JSON Schema
  const { $schema, ...schema } = jsonSchema;
  return {
    name: tool.name,
    description: tool.description,
    parameters: schema as JsonSchema,
  };
}
```

---

### C.11 PersistenceAdapter 的额外字段（支持 Worker）

当前 `PersistenceAdapter` 接口缺少 Worker 所需的锁定字段。需要两个功能：
1. **锁定（lease）**：防止多个 worker 同时处理同一个 run
2. **原子获取**：在同一个操作中查询 + 锁定

**扩展接口：**

```typescript
interface PersistenceAdapter {
  // ... 现有方法 ...

  /**
   * 原子地获取并锁定待处理的 runs。
   * 只有 PostgresAdapter 真正支持原子性（SELECT ... FOR UPDATE SKIP LOCKED）。
   * InMemoryAdapter 和 FileSystemAdapter 实现尽力而为的版本。
   */
  acquirePendingRuns(opts: {
    statuses: RunStatus[];
    workerId: string;
    leaseTtlMs: number;
    batchSize: number;
  }): Promise<RunState[]>;

  /** 续约锁 */
  renewLease(runId: string, workerId: string, leaseTtlMs: number): Promise<boolean>;

  /** 释放锁 */
  releaseLease(runId: string, workerId: string): Promise<void>;

  /** 获取锁的状态（用于 worker 恢复判断） */
  getLease(runId: string): Promise<{ workerId: string; lockedAt: number } | null>;
}
```

**RunState 增加锁字段：**

```typescript
type RunState = {
  // ... 现有字段
  /** Worker 锁信息（可空——没有锁时为空） */
  lockedBy?: string;
  lockedAt?: number;
};
```

---

### C.12 Worker 状态的 "ready" 是 RunManager 的责任

正文的 `WorkerConfig.statuses` 默认值为 `["ready"]`，但 `RunStatus` 中没有 `"ready"`。

**明确：** Worker 的 poll 逻辑由一个内部函数将 "ready" 映射到实际的 RunStatus：

```typescript
// Worker 内部
async poll() {
  const statuses = this.config.statuses?.map(s => {
    // "ready" 映射为刚刚创建、尚未开始的状态
    if (s === "ready") return undefined; // 特殊处理
    return s;
  }).filter(Boolean) as RunStatus[];

  // ready 状态通过 RunManager 内部的一个特殊字段表示
  // 或者我们在 RunStatus 中增加 "ready"
}
```

**决定：增加 `"ready"` 到 `RunStatus`。**

```typescript
type RunStatus =
  | "ready"             // Run 已创建但尚未开始执行（新增）
  | "running"
  | "waiting_input"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";
```

---

### C.13 AgentResult 的 finishReason + error 有效组合

| finishReason | error | 含义 |
|-------------|-------|------|
| `"stop"` | `undefined` | LLM 正常给出最终答案 |
| `"tool_calls"` | `undefined` | 本不该出现（tool_calls 应该在步骤中间被消费，不是最终结果） |
| `"error"` | `AgentError` | LLM 不可恢复错误、工具灾难性失败、取消 |
| `"max_steps"` | `undefined` | 达到最大步数，未完成 |
| `"handoff"` | `undefined` | 控制权转移（附带 `handoff` 字段） |
| `"cancelled"` | `AgentError` (code: CANCELLED) | 外部取消 |

**类型约束：**

```typescript
type AgentResult = {
  // ...
  finishReason: "stop" | "error" | "max_steps" | "handoff" | "cancelled";
  error?: AgentError;  // 仅当 finishReason === "error" 或 "cancelled" 时非空
  handoff?: HandoffInfo;  // 仅当 finishReason === "handoff" 时非空
};
```

---

### C.14 RunManager.create() 启动语义

**正文的问题：** "创建一个新的 managed run 并立即开始执行"——但执行是 lazy 的还是 eager 的？

**明确：Eager 启动。** `RunManager.create()` 立即在后台启动 agent()，准备好了状态后立刻开始流式产出事件。

但 `stream()` 的消费可以是 lazy 的——调用方不消费，事件会被缓冲（在内存中或持久化到 adapter）。

**实现：**

```typescript
static create(input, agentFn, opts): ManagedRun {
  const runId = input.runId ?? generateId();
  const initialState = initState(runId, input);
  opts?.adapter?.saveState(initialState);

  const rm = new RunManagerImpl(runId, agentFn, initialState, opts?.adapter);
  // 不在这里启动 agent，在第一次 stream() 调用时懒启动
  return rm;
}
```

最终选择 **Lazy 启动**——agent() 在第一次 `stream()` 调用时才执行，避免不必要的资源消耗。

---

### C.15 内部依赖：LLMClient 默认值

`AgentInput.llmClient` 可选，不传时使用全局默认。这个默认值如何设置？

```typescript
// 设置全局默认 LLM 客户端
import { setDefaultLLMClient } from "@renx/agent-v2";

const client = createOpenAIClient({ apiKey: "..." });
setDefaultLLMClient(client);

// 之后创建的 agent 自动使用
const gen = agent({ model: "gpt-4o", systemPrompt: "...", messages: [...] });
```

**实现：** 模块级可变状态（类似 v1 的 `@renx/provider` 模式）。

```typescript
// src/llm-client.ts
let _defaultClient: LLMClient | undefined;

export function setDefaultLLMClient(client: LLMClient): void {
  _defaultClient = client;
}

export function getDefaultLLMClient(): LLMClient {
  if (!_defaultClient) {
    throw new Error("No LLMClient configured. Call setDefaultLLMClient() or pass llmClient in AgentInput.");
  }
  return _defaultClient;
}
```

---

### C.16 完整目录结构修正

考虑 C.2-C.15 的所有补充后，实际需要新增的文件：

```
packages/agent-v2/
├── src/
│   ├── index.ts
│   ├── types.ts                  # AgentInput, AgentResult, AgentGenerator
│   ├── state.ts                  # RunState + initState()
│   ├── events.ts                 # AgentEvent 联合类型（含 handoff）
│   ├── errors.ts                 # AgentError, AgentErrorCode
│   ├── message.ts                # Message 系列
│   ├── tool.ts                   # Tool, ToolContext, CanonicalToolSchema
│   ├── llm-client.ts             # LLMClient, LLMChunk, setDefaultLLMClient
│   │
│   ├── agent.ts                  # agent() 核心生成器
│   ├── accumulator.ts            # tool-call-delta 累积器（新增，核心算法）
│   ├── handoff-signal.ts         # HandoffSignal 类（新增）
│   ├── plugin.ts                 # Plugin 类型 + pipe()
│   │
│   ├── plugins/
│   │   ├── logging.ts
│   │   ├── retry.ts
│   │   ├── approval.ts
│   │   ├── telemetry.ts
│   │   ├── prompt-guard.ts
│   │   ├── timeout.ts
│   │   ├── step-timeout.ts
│   │   ├── max-tokens.ts
│   │   └── cache.ts
│   │
│   ├── multi-agent/
│   │   ├── agent-as-tool.ts
│   │   └── handoff.ts
│   │
│   ├── runner/
│   │   ├── manager.ts            # RunManagerImpl
│   │   ├── worker.ts             # createWorker
│   │   └── adapters/
│   │       ├── adapter.ts        # PersistenceAdapter 接口（含锁方法）
│   │       ├── memory.ts
│   │       ├── filesystem.ts
│   │       └── postgres.ts
│   │
│   ├── telemetry/
│   │   ├── types.ts
│   │   ├── otel.ts
│   │   └── console.ts
│   │
│   └── utils/
│       ├── id.ts
│       ├── logger.ts
│       ├── abort.ts
│       └── converter.ts          # tool → CanonicalToolSchema 转换（新增）
```
---

### C.17 上下文窗口溢出管理 (Context Window Management)

**问题：**

长期运行的 agent（多步 tool calling、大文件读取）会使 `messages` 持续增长，最终超出 LLM 的上下文窗口限制（如 Claude 的 200K tokens）。目前的设计只在 `withMaxTokens` Plugin 中覆盖了累计 token 监控，但没有处理**单个 message list 超过 context window** 的场景。

**影响域：**

| 场景 | 触发条件 | 影响 |
|------|----------|------|
| 大文件工具输出 | `read_file` 返回 100K 字符内容 | context window 被单条工具结果占满 |
| 多步对话 | 20+ step 的复杂任务 | messages 累积超出限制 |
| 嵌套 agent | `agentAsTool` 中父子 agent 共享 messages | 子 agent 可能也超限 |
| 长系统提示词 | 复杂的 system prompt | 进一步减少可用空间 |

**解决策略（为 Layer 2 建议的实现）：**

agent() 在每一轮循环开始前，都应该评估当前 message list 是否即将超出 context window：

```
// agent() 内部，每一轮开始时
function estimateTokens(messages: Message[]): number { ... }

function buildLLMRequest(state, input, maxContextTokens): LLMStreamRequest {
  // 1. 计算 system prompt 和 tools 占用的 token 数（固定开销）
  const fixedOverhead = estimateTokens(systemPrompt) + estimateToolsTokens(tools);

  // 2. 计算可用于 messages 的 token 配额
  const messageBudget = maxContextTokens - fixedOverhead;

  // 3. 如果有 summary，优先使用 summary 替换旧消息
  if (state.summary) {
    const summarizedMessages = injectSummary(state.summary, state.messages, messageBudget);
    return { ...request, messages: summarizedMessages };
  }

  // 4. 如果没有 summary，使用滑动窗口 + 保留最近 N 轮
  const truncatedMessages = truncateMessages(state.messages, messageBudget, {
    preserveSystemMessages: true,  // 保留 system prompt
    preserveRecentRounds: 3,       // 保留最近 3 轮对话
  });

  return { ...request, messages: truncatedMessages };
}
```

**不同策略的取舍：**

| 策略 | 实现难度 | Token 效率 | 信息保真度 |
|------|----------|-----------|------------|
| **滑动窗口**（只保留最近 N 条消息） | 低 | 中 | 低（丢失早期上下文） |
| **Summary 注入**（用摘要替换历史） | 中 | 高 | 中（摘要会丢失细节） |
| **动态截断工具结果**（只保留工具输出的摘要） | 中 | 高 | 中 |
| **滑动窗口 + Summary 混合** | 高 | 最高 | 最高 |

**建议：**

1. **Phase 1-2（基础实现）**：不做消息截断，但记录每条消息的 token 估算值，当接近 context window 时通过 `withMaxTokens` Plugin 发出警告。
2. **Phase 3（生产就绪）**：实现 Summary 注入策略，与现有的 `SummaryManager` 集成（v1 已有类似组件）。
3. **Phase 4+（高级）**：添加 `AgentInput` 选项让用户选择策略：

```typescript
type AgentInput = {
  // ...
  /** 上下文窗口管理策略 */
  contextWindow?: {
    /** 最大上下文 token 数。默认等于模型上限 */
    maxTokens?: number;
    /** 策略 */
    strategy: "none" | "sliding_window" | "summary";
    /** 滑动窗口：保留最近 N 轮完整对话 */
    slidingWindowRounds?: number;
    /** Summary：summary 管理器 */
    summary?: SummaryManager;
  };
};
```

---

### C.18 workingMemory 浅拷贝语义

**正文的矛盾：**

- §3.1 声明 `RunState` 是不可变的
- C.8 允许工具通过 `ctx.workingMemory` 直接写入
- 持久化时使用浅拷贝 `{ ...workingMemory }`

**明确的语义级别定义：**

`workingMemory` 有三种视图：

```
┌─────────────────────────────────────────────────┐
│  运行中（工具视角）                               │
│  ctx.workingMemory = mutable ref                │
│  工具可以: x.y = z, x.arr.push(...)  ✅          │
└─────────────────────────────────────────────────┘
                    │
                    ▼ shallow copy on persist
┌─────────────────────────────────────────────────┐
│  持久化（adapter 视角）                           │
│  state.workingMemory = { ...current }            │
│  一级属性被复制，嵌套引用被共享                    │
└─────────────────────────────────────────────────┘
                    │
                    ▼ JSON.stringify / loadState
┌─────────────────────────────────────────────────┐
│  恢复（新 run 视角）                              │
│  loaded.workingMemory = 全新对象                  │
│  与之前的引用完全隔离                              │
└─────────────────────────────────────────────────┘
```

**工具作者的注意事项：**

```typescript
// ✅ 安全：直接赋值顶层属性
ctx.workingMemory.filePath = "/tmp/output.txt";
ctx.workingMemory.counter = (ctx.workingMemory.counter ?? 0) + 1;

// ❌ 危险：嵌套对象的属性修改不会正确持久化
// 持久化是浅拷贝，嵌套突变在持久化时丢失
ctx.workingMemory.details = {};           // 先创建顶层属性
ctx.workingMemory.details.status = "ok";  // ✅ 这一行安全（details 引用在浅拷贝中保留）
//
// 但如果你从上次持久化的 workingMemory 中引用了 nested，然后修改：
const cache = state.workingMemory.cache;  // 从持久化恢复的 nested
cache.fileA = await readFile(...);         // ❌ cache 引用可能已过期

// ✅ 正确做法：使用完整对象替换
ctx.workingMemory.cache = {
  ...ctx.workingMemory.cache,
  fileA: await readFile(...),
};
```

**持久化实现：**

```typescript
// 在代理层持久化时进行结构克隆，确保外部看到的是快照
async function persistState(state: RunState, adapter: PersistenceAdapter): Promise<void> {
  const snapshot = {
    ...state,
    // structuredClone 保证深度拷贝，避免持久化后仍共享引用
    workingMemory: structuredClone(state.workingMemory),
  };
  await adapter.saveState(snapshot);
}
```

或者使用 `structuredClone` 作为持久化前的标准步骤：

```typescript
function deepCloneState(state: RunState): RunState {
  // structuredClone 是 Web API，Node 17+ 支持
  // 如果目标环境不支持，使用 JSON.parse(JSON.stringify(...))
  return structuredClone(state);
}
```

**结论：** `RunState` 在外部 API 层面表现为不可变——持久化后返回的 state 是深拷贝。运行中的 `ctx.workingMemory` 是可变的草稿纸，工具应遵循不可变更新模式（替换引用而非修改嵌套属性），但这不是强制的。

---

### C.19 withRetry Plugin 的重试范围

**设计决策：withRetry 的默认重试粒度是"整个 agent run"，而非"单个 LLM 调用"。**

**当前 withRetry 的实现逻辑：**

```typescript
function withRetry(opts: RetryConfig): Plugin {
  return (inner) =>
    async function* (input) {
      let attempt = 0;
      while (attempt <= maxRetries) {
        attempt++;
        const events: AgentEvent[] = [];
        const gen = inner(input);  // ← 重新创建整个 agent run

        for await (const event of gen) {
          if (event.type === "llm:done" && event.finishReason === "error") {
            events.push(event);
            break;  // LLM 错误，break 消费循环
          }
          events.push(event);
          yield event;  // 正常事件直接转发
        }

        if (/* 不是可重试错误 */) return;

        // 可重试：丢弃本轮已 yield 的事件，等待后从头开始
        if (attempt <= maxRetries) {
          await sleep(computeDelay(attempt, opts));
          continue;  // 重新 while 循环 → 重新 inner(input)
        }
      }
    };
}
```

**权衡分析：**

| 维度 | 全 run 重试（当前设计） | 单步 LLM 重试 |
|------|------------------------|---------------|
| 实现复杂度 | 低（Plugin 层即可实现） | 高（需要在 agent() 内部集成） |
| 效率 | 低（重试会放弃已执行步骤的 work） | 高（只重试失败的 LLM 调用） |
| 正确性 | 高（从初始状态重新开始，无状态污染） | 中（需要"倒带"到出错前的状态） |
| Plugin 层可实现？ | 是 | 否（需要 agent() 内部暴露重试钩子） |

**主要风险场景：**

```
假设一个 5-step agent run：
  Step 1: LLM → tool_calls → 执行成功 ✓
  Step 2: LLM → tool_calls → 执行成功 ✓
  Step 3: LLM → text ✓
  Step 4: LLM → tool_calls → 执行成功 ✓
  Step 5: LLM → ERROR (rate limited) ✗

withRetry 全 run 重试：
  重试第 1 次：从 step 1 重新开始
  → 前 4 步的 LLM token 都浪费了
  → 重复执行所有工具调用（可能产生副作用）
```

**改善计划（Phase 2+）：**

在 agent() 内部添加可选的重试钩子：

```typescript
type AgentInput = {
  // ...
  /**
   * LLM 调用出错时的重试策略。
   * 如果设置了此项，agent() 在 LLM 调用失败时不会立即放弃，
   * 而是按此策略重试单步 LLM 调用。
   */
  llmRetry?: {
    maxRetries: number;
    baseDelayMs?: number;
    backoffMultiplier?: number;
    /** 判断错误是否可重试，默认所有错误 */
    isRetryable?: (error: AgentError) => boolean;
  };
};
```

单步重试的 agent() 内部逻辑：

```
function* agent(input):
  while state.stepCount < maxSteps:
    // LLM 调用带重试
    for attempt = 0 to input.llmRetry?.maxRetries ?? 0:
      for each chunk from llmClient.stream(request):
        ...正常处理...
        if chunk.type === "error":
          if not isRetryable(chunk.error) or attempt >= maxRetries:
            // 不可重试或已达上限 → 继续 LLM error 流程
            break outer
          await sleep(computeDelay(attempt))
          continue  // 重试 LLM 调用

    // 继续正常的决策路由和工具执行...
```

**建议：**

1. **Phase 1**：使用 Plugin 层的 `withRetry`（全 run 重试）作为默认。对于短命 agent（1-3 步），这个开销可接受。
2. **Phase 2**：在 `AgentInput` 中添加 `llmRetry` 选项，agent() 内部集成单步重试。
3. **文档中明确说明** `withRetry` Plugin 的重试范围和权衡。
