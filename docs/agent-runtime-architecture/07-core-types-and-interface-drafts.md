# 07. 核心类型与接口草案

本文件的目标是把前面几份偏架构层的说明进一步收紧成“接口草案级别”的设计。

注意：

- 这里不是最终 TypeScript 代码
- 但这里的字段、方法、输入输出结构应尽量稳定
- 后续实现时建议优先以本文件为接口蓝本

## 1. 设计目标

本文件主要解决两个问题：

1. 实现时核心对象应该长什么样
2. 每个核心模块应该暴露哪些方法

如果没有这一层，后面很容易出现：

- 模块边界写着清楚，但真正实现时对象结构混乱
- 各层传参风格不一致
- 后面需要重构很多数据结构

## 2. 核心类型总览

建议优先定义下面这些核心类型：

- `AgentRun`
- `RunStatus`
- `RunBudget`
- `StepState`
- `StepContext`
- `AgentDecision`
- `ToolInvocation`
- `ToolExecutionResult`
- `ToolObservation`
- `PermissionDecision`
- `TerminationDecision`
- `MemoryEntry`
- `MemoryCandidate`
- `SummarySnapshot`
- `RuntimeEvent`

建议先把这些对象定义清楚，再开始写具体逻辑。

---

## 3. AgentRun

`AgentRun` 表示一次完整任务运行实例。它是整个系统里最顶层的业务对象。

### 3.1 必需字段

建议字段如下：

```text
AgentRun
- runId: string
- agentId: string
- threadId?: string
- status: RunStatus
- userGoal: string
- inputMessages: CanonicalMessage[]
- createdAt: string
- updatedAt: string
- startedAt?: string
- finishedAt?: string
- stepIndex: number
- budget: RunBudget
- pendingApproval?: PendingApproval
- pendingUserInput?: PendingUserInput
- finalResult?: FinalResult
- error?: RunError
- metadata?: Record<string, unknown>
```

### 3.2 每个字段为什么存在

#### `runId`

唯一标识一次 run，用于：

- checkpoint
- trace
- memory 写入归属
- tool 调用归属

#### `agentId`

标识当前是哪个 agent 配置在执行。

#### `threadId`

如果未来支持多次会话复用同一个线程上下文，这个字段很有价值。

#### `status`

来自状态机，是 run 当前状态的唯一真相。

#### `userGoal`

原始任务目标。即使后面有 summary，也必须保留原始目标字段。

#### `inputMessages`

原始输入消息。不要只保留压缩后的上下文，原始输入必须可追溯。

#### `stepIndex`

表示当前已经推进到第几轮。

#### `budget`

统一管理 token、step、tool call、duration 等预算。

#### `pendingApproval`

用来在 `waiting_permission` 状态恢复时，重新拿回待审批的工具调用。

#### `pendingUserInput`

用来在 `waiting_input` 状态恢复时，明确缺少的输入是什么。

#### `finalResult`

最终结果对象，不要只留最终字符串。

#### `error`

结构化错误，便于区分失败类型。

### 3.3 AgentRun 相关方法建议

在运行时中应围绕 `AgentRun` 提供下列能力：

- `createRun(input): AgentRun`
- `loadRun(runId): AgentRun`
- `saveRun(run): void`
- `markRunStarted(run): AgentRun`
- `markRunFinished(run, result): AgentRun`
- `markRunFailed(run, error): AgentRun`
- `markRunWaitingApproval(run, pendingApproval): AgentRun`
- `markRunWaitingInput(run, pendingUserInput): AgentRun`

---

## 4. RunStatus

建议定义为稳定枚举。

```text
RunStatus
- ready
- running
- waiting_permission
- waiting_input
- paused
- finished
- failed
- cancelled
```

这组状态应该尽量少改，因为会影响：

- 存储
- UI
- trace
- 恢复逻辑

---

## 5. RunBudget

`RunBudget` 是 runtime 保持可控的重要对象，不建议只散落几个数字配置。

### 5.1 建议字段

```text
RunBudget
- maxSteps: number
- maxToolCalls: number
- maxDurationMs?: number
- maxInputTokensPerStep?: number
- maxTotalTokens?: number
- maxConsecutiveFailures?: number
- currentToolCalls: number
- currentElapsedMs?: number
- currentTotalTokens?: number
```

### 5.2 为什么必须结构化

因为后续 `TerminationPolicy` 和 `Harness` 都要用到预算信息。

如果这些数字散落在各层：

- budget 检查容易不一致
- trace 和错误报告也会变得混乱

---

## 6. StepState

`StepState` 表示单轮 step 的完整快照。

### 6.1 建议字段

```text
StepState
- runId: string
- stepIndex: number
- startedAt: string
- endedAt?: string
- context: StepContext
- modelRequest?: ModelRequest
- modelResponse?: ModelResponse
- decision?: AgentDecision
- toolInvocations?: ToolInvocation[]
- toolResults?: ToolExecutionResult[]
- observations?: ToolObservation[]
- memoryCandidates?: MemoryCandidate[]
- summaryUpdated?: boolean
- terminationDecision?: TerminationDecision
- error?: StepError
```

### 6.2 为什么 StepState 必须完整

因为它直接决定：

- 单轮调试能力
- step 级 checkpoint 能力
- 问题回溯能力

### 6.3 StepState 的使用原则

建议：

- 每一轮 step 开始时创建
- 每经过一个关键节点就补充字段
- step 结束时落一次完整快照

---

## 7. StepContext

`StepContext` 是喂给模型前的统一上下文对象。

### 7.1 建议字段

```text
StepContext
- runId: string
- stepIndex: number
- systemInstructions: string
- goal: string
- recentMessages: CanonicalMessage[]
- summary?: SummarySnapshot
- relevantMemories: MemoryEntry[]
- availableTools: ToolDescriptor[]
- constraints: RuntimeConstraints
- metadata?: Record<string, unknown>
```

### 7.2 设计原则

不要让每一层都直接拼 prompt 文本。

应先生成结构化 `StepContext`，再由更下游的层转成模型需要的 messages / prompt。

这样好处是：

- 更容易测试
- 更容易插 hook
- 更容易做模型适配

---

## 8. AgentDecision

`AgentDecision` 是 ReActLoopEngine 输出给 Harness 的统一决策对象。

### 8.1 建议字段

```text
AgentDecision
- type: DecisionType
- reasoningSummary?: string
- finalAnswer?: string
- toolCalls?: ToolInvocationDraft[]
- askUserMessage?: string
- blockedReason?: string
- confidence?: number
- metadata?: Record<string, unknown>
```

### 8.2 DecisionType 建议值

```text
DecisionType
- final_answer
- tool_calls
- ask_user
- blocked
```

### 8.3 为什么一定要统一 Decision

如果 Harness 直接消费 provider 原始结果：

- 上层会耦合 provider 细节
- 不同模型和厂商的差异会污染主流程

`AgentDecision` 的意义就是把“模型返回了什么”收敛成“runtime 该怎么处理”。

---

## 9. ToolInvocation

`ToolInvocation` 表示一次已确定要执行的工具调用。

### 9.1 建议字段

```text
ToolInvocation
- toolCallId: string
- toolName: string
- args: Record<string, unknown>
- requestedByRunId: string
- requestedByStep: number
- timeoutMs?: number
- sandboxProfile?: string
- permissionProfile?: string
- retryable?: boolean
- idempotent?: boolean
- metadata?: Record<string, unknown>
```

### 9.2 ToolInvocationDraft 与 ToolInvocation 的区别

建议拆成两个阶段：

- `ToolInvocationDraft`
  - 来自模型决策，尚未通过 runtime 补充元信息

- `ToolInvocation`
  - 已经补齐 runtime 所需字段，可进入真正执行

这样可以让决策解析和实际执行分层更清楚。

---

## 10. ToolExecutionResult

### 10.1 建议字段

```text
ToolExecutionResult
- toolCallId: string
- toolName: string
- success: boolean
- outputText?: string
- structuredData?: Record<string, unknown>
- artifacts?: ArtifactRef[]
- error?: ToolError
- exitCode?: number | null
- durationMs: number
- truncated?: boolean
- metadata?: Record<string, unknown>
```

### 10.2 为什么同时保留 `outputText` 和 `structuredData`

- `outputText`
  - 方便 observation 和模型消费

- `structuredData`
  - 方便 memory 提取、前端展示、后续程序化消费

---

## 11. ToolObservation

`ToolObservation` 是写回模型上下文的标准化结果，不等于原始执行结果。

### 11.1 建议字段

```text
ToolObservation
- toolCallId: string
- toolName: string
- inputSummary: string
- resultSummary: string
- success: boolean
- errorSummary?: string
- artifactRefs?: ArtifactRef[]
- rawResultRef?: string
```

### 11.2 为什么 Observation 要独立建模

因为 observation 面向的是“下一轮推理”，不是面向“工具底层结果保存”。

它的目标是：

- 压缩
- 摘要
- 让模型看得懂

---

## 12. PermissionDecision

### 12.1 建议字段

```text
PermissionDecision
- decision: allow | deny | ask
- reason: string
- riskLevel?: low | medium | high
- approvalMessage?: string
- approvalPayload?: Record<string, unknown>
- expiresAt?: string
```

### 12.2 为什么不是简单 boolean

因为工具授权场景至少要支持：

- 自动允许
- 自动拒绝
- 需要审批

如果只返回 boolean，后续审批流程无法自然接入。

---

## 13. TerminationDecision

### 13.1 建议字段

```text
TerminationDecision
- action: continue | finish | ask_user | fail
- reason: string
- category?: success | budget | stall | blocked | handoff
- nextPromptToUser?: string
```

### 13.2 为什么要包含 `category`

因为不同终止原因后续处理完全不同：

- `success`
  - 返回正常结果
- `budget`
  - 返回预算超限提示
- `stall`
  - 返回空转中止说明
- `blocked`
  - 提示缺条件

---

## 14. MemoryEntry 与 MemoryCandidate

建议将“候选记忆”和“正式记忆”拆开。

### 14.1 MemoryCandidate

```text
MemoryCandidate
- type: profile | procedural | episodic | artifact
- content: string
- summary?: string
- tags?: string[]
- importance?: number
- confidence?: number
- sourceRunId: string
- sourceStepIndex: number
```

### 14.2 MemoryEntry

```text
MemoryEntry
- memoryId: string
- type: profile | procedural | episodic | artifact
- scope?: string
- content: string
- summary?: string
- tags?: string[]
- importance?: number
- confidence?: number
- ttl?: number
- sourceRunId?: string
- createdAt: string
- lastUsedAt?: string
```

### 14.3 为什么拆成两个对象

因为写入长期 memory 前通常还要经过：

- 评分
- 去重
- 合并
- policy check

---

## 15. SummarySnapshot

### 15.1 建议字段

```text
SummarySnapshot
- summaryId: string
- runId: string
- stepIndex: number
- goal: string
- completedWork: string[]
- knownFacts: string[]
- unresolvedIssues: string[]
- blockers: string[]
- generatedAt: string
```

### 15.2 为什么 summary 不该只是一段文本

结构化 summary 更利于：

- 调试
- 合并更新
- UI 展示
- 终止判断

---

## 16. RuntimeEvent

事件总线建议统一结构。

### 16.1 建议字段

```text
RuntimeEvent
- eventId: string
- runId: string
- stepIndex?: number
- type: string
- timestamp: string
- payload: Record<string, unknown>
```

### 16.2 常见事件类型建议

- `run.started`
- `step.started`
- `context.built`
- `model.called`
- `decision.parsed`
- `tool.requested`
- `tool.executed`
- `permission.asked`
- `memory.persisted`
- `termination.evaluated`
- `run.finished`
- `run.failed`

---

## 17. AgentRuntime 接口草案

这里给出模块级接口草案，不是代码实现。

### 17.1 AgentRuntime 公开能力

```text
AgentRuntime
- createRun(input): AgentRun
- startRun(runId): AgentRun
- resumeRun(runId, resumeInput?): AgentRun
- pauseRun(runId): AgentRun
- cancelRun(runId): AgentRun
- getRun(runId): AgentRun
- getRunTrace(runId): RuntimeEvent[]
```

### 17.2 实现约束

- `createRun` 不做真正执行
- `startRun` 只能从 `ready` 进入 `running`
- `resumeRun` 只能从 `paused / waiting_permission / waiting_input` 恢复
- `cancelRun` 一旦成功，后续不应再继续执行新 step

---

## 18. Harness 接口草案

### 18.1 建议能力

```text
Harness
- runUntilStop(run): AgentRun
- runSingleStep(run): StepState
- buildStepContext(run): StepContext
- dispatchDecision(run, decision): StepState
- handleToolCalls(run, toolCalls): StepState
- handleFinalAnswer(run, decision): StepState
- updateMemoryAndSummary(run, stepState): void
- checkTermination(run, stepState): TerminationDecision
```

### 18.2 实现约束

- `runUntilStop` 只能围绕状态机运行
- `runSingleStep` 不应直接跨过 `dispatchDecision`
- `handleToolCalls` 不应直接执行工具实现，而应委托给 `ToolRuntime`
- `checkTermination` 必须在 observation / summary 更新之后调用

---

## 19. ReActLoopEngine 接口草案

### 19.1 建议能力

```text
ReActLoopEngine
- executeStep(context): AgentDecision
```

### 19.2 内部执行步骤

建议内部固定做：

1. `buildModelRequest(context)`
2. `callModel(request)`
3. `normalizeModelResponse(response)`
4. `parseDecision(response)`
5. `return AgentDecision`

---

## 20. ToolRuntime 接口草案

### 20.1 建议能力

```text
ToolRuntime
- execute(invocations, context): ToolRuntimeResult
```

其中 `ToolRuntimeResult` 应包含：

- `status`
  - `completed`
  - `waiting_permission`
  - `denied`
  - `failed`
- `toolResults`
- `observations`
- `pendingApproval`
- `error`

### 20.2 为什么 ToolRuntime 结果也要结构化

因为工具层不仅可能“成功完成”，还可能：

- 等待审批
- 被拒绝
- 部分成功
- 执行失败

Harness 需要靠这个结构来做后续状态切换。

---

## 21. MemoryManager 接口草案

### 21.1 建议能力

```text
MemoryManager
- retrieveRelevantMemories(run, stepContext): MemoryEntry[]
- extractCandidates(run, stepState): MemoryCandidate[]
- persistCandidates(run, candidates): MemoryEntry[]
- updateSummary(run, stepState): SummarySnapshot
- compressContextIfNeeded(run, stepContext): StepContext
```

### 21.2 设计约束

- 检索 memory 在模型调用前
- 生成 memory candidate 在 step 结束后
- summary 更新不要和 memory 持久化耦死在一个函数里

---

## 22. TerminationPolicy 接口草案

### 22.1 建议能力

```text
TerminationPolicy
- evaluate(run, stepState): TerminationDecision
```

### 22.2 设计约束

- 不应只依赖模型一句“完成了”
- 应结合 budget、blocker、重复行为、summary 等因素判断

---

## 23. 本文件结论

本文件的目的，是把“要做什么模块”继续细化为“每个模块至少要围绕哪些稳定对象和方法实现”。

建议后续实现顺序：

1. 先定义本文件里的核心类型
2. 再围绕这些类型去实现状态机和 Harness
3. 再接入 ToolRuntime / MemoryManager / TerminationPolicy

这样后续改动会更少，模块边界也会更稳。

