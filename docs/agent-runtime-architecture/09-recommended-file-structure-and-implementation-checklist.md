# 09. 推荐文件结构与实现清单

本文件把前面的架构与接口设计进一步落成“代码组织建议 + 按文件的实现清单”。

它的目标不是规定绝对唯一的目录结构，而是减少实现阶段的结构摇摆。

如果不先定文件拆分，常见问题包括：

- 一个文件越来越大
- 类型定义散在业务模块里
- runtime、tool、memory 互相引用缠绕

## 1. 顶层目录建议

建议在 `packages/agent/src/` 下按领域拆分：

```text
packages/agent/src/
  runtime/
    agent-runtime.ts
    harness.ts
    react-loop-engine.ts
    run-state-machine.ts
    decision-router.ts

  model/
    model-gateway.ts
    model-compatibility-strategy.ts
    decision-parser.ts

  tools/
    tool-runtime.ts
    tool-registry.ts
    tool-executor.ts
    tool-observation.ts

  permissions/
    permission-engine.ts
    permission-policy.ts

  sandbox/
    sandbox-manager.ts
    sandbox-profile.ts
    sandbox-types.ts

  memory/
    memory-manager.ts
    memory-store.ts
    memory-write-policy.ts
    memory-retrieval-policy.ts
    context-builder.ts
    context-compressor.ts
    summary-manager.ts

  termination/
    termination-policy.ts

  hooks/
    hook-kernel.ts
    hook-types.ts
    plugin-registry.ts

  events/
    event-bus.ts
    trace-types.ts

  persistence/
    checkpoint-store.ts
    run-repository.ts
    step-repository.ts

  types/
    run.ts
    step.ts
    decision.ts
    tool.ts
    memory.ts
    event.ts
    error.ts
```

## 2. 先实现哪些文件

不是所有文件都要同时开始。建议分 3 批。

### 第一批：主链骨架

先实现这些文件：

- `types/run.ts`
- `types/step.ts`
- `types/decision.ts`
- `runtime/run-state-machine.ts`
- `runtime/agent-runtime.ts`
- `runtime/harness.ts`
- `runtime/react-loop-engine.ts`
- `model/decision-parser.ts`

这一批的目标是打通最小闭环。

### 第二批：工具执行层

再实现：

- `types/tool.ts`
- `tools/tool-registry.ts`
- `tools/tool-executor.ts`
- `tools/tool-runtime.ts`
- `permissions/permission-engine.ts`
- `sandbox/sandbox-manager.ts`

这一批的目标是把 tool 分支独立出来。

### 第三批：上下文、记忆与终止

再实现：

- `memory/context-builder.ts`
- `memory/context-compressor.ts`
- `memory/summary-manager.ts`
- `memory/memory-manager.ts`
- `memory/memory-store.ts`
- `termination/termination-policy.ts`

这一批的目标是让 runtime 具备长期稳定执行能力。

## 3. 按文件详细说明

下面这一节是本文件最重要的部分。每个文件我都会写：

- 这个文件应该放什么
- 不应该放什么
- 实现时至少要完成哪些步骤

---

## 4. `types/run.ts`

### 应该放什么

- `RunStatus`
- `RunBudget`
- `PendingApproval`
- `PendingUserInput`
- `FinalResult`
- `AgentRun`

### 不应该放什么

- 方法实现
- 工具相关结构
- memory 结构

### 实现步骤

1. 定义稳定的 `RunStatus` 枚举
2. 定义 `RunBudget`
3. 定义 `PendingApproval` 与 `PendingUserInput`
4. 定义 `FinalResult`
5. 定义 `AgentRun`

### 验收标准

- Runtime 层不再用松散对象表示一次 run

---

## 5. `types/step.ts`

### 应该放什么

- `StepState`
- `StepContext`
- `StepError`

### 不应该放什么

- Decision type
- Tool type

### 实现步骤

1. 定义 `StepContext`
2. 定义 `StepState`
3. 让 `StepState` 可以覆盖一轮 step 的完整生命周期

### 验收标准

- step 级日志和 checkpoint 已可用统一结构表示

---

## 6. `types/decision.ts`

### 应该放什么

- `DecisionType`
- `AgentDecision`
- `TerminationDecision`

### 实现步骤

1. 定义 `DecisionType`
2. 定义 `AgentDecision`
3. 定义 `TerminationDecision`

### 验收标准

- Harness 不再直接消费 provider 原始返回

---

## 7. `types/tool.ts`

### 应该放什么

- `ToolDescriptor`
- `ToolInvocationDraft`
- `ToolInvocation`
- `ToolExecutionResult`
- `ToolObservation`
- `ToolRuntimeResult`

### 实现步骤

1. 定义工具定义结构
2. 定义调用对象
3. 定义结果对象
4. 定义 observation 对象
5. 定义工具运行层返回对象

### 验收标准

- 工具层全链路都使用结构化类型

---

## 8. `types/memory.ts`

### 应该放什么

- `MemoryCandidate`
- `MemoryEntry`
- `SummarySnapshot`

### 实现步骤

1. 定义候选记忆
2. 定义正式记忆
3. 定义 summary 结构

### 验收标准

- memory 与 summary 不再只是字符串

---

## 9. `runtime/run-state-machine.ts`

### 应该放什么

- 合法状态迁移规则
- 基于事件的状态转换

### 不应该放什么

- 模型调用逻辑
- memory 逻辑

### 实现步骤

1. 定义所有允许的状态
2. 定义所有事件
3. 定义每个状态允许的迁移
4. 在非法迁移时返回错误

### 验收标准

- run 状态切换不能靠随意赋值完成

---

## 10. `runtime/agent-runtime.ts`

### 应该放什么

- 对外公开运行接口
- run 的创建、加载、启动、恢复、取消

### 不应该放什么

- 单轮 ReAct 细节
- tool 执行细节

### 实现步骤

1. 实现 `createRun`
2. 实现 `startRun`
3. 实现 `resumeRun`
4. 实现 `pauseRun`
5. 实现 `cancelRun`
6. 实现 `getRun`
7. 实现 `getRunTrace`

### 验收标准

- 外部调用者只通过这一层驱动 run

---

## 11. `runtime/harness.ts`

### 应该放什么

- 主循环编排
- 单轮 step 编排
- 决策分发
- 收尾逻辑

### 不应该放什么

- provider adapter 细节
- 工具底层执行实现

### 实现步骤

1. 实现 `runUntilStop`
2. 实现 `runSingleStep`
3. 实现 `buildStepContext` 调用链
4. 实现 `dispatchDecision`
5. 实现 `updateMemoryAndSummary`
6. 实现 `checkTermination`

### 验收标准

- 主循环可从一个地方完整读懂

---

## 12. `runtime/react-loop-engine.ts`

### 应该放什么

- 单轮模型交互流程

### 不应该放什么

- 状态迁移
- tool 执行

### 实现步骤

1. 接收 `StepContext`
2. 构建模型请求
3. 调用 `ModelGateway`
4. 解析 `AgentDecision`
5. 返回决策

### 验收标准

- 一轮模型交互的职责明确且可替换

---

## 13. `runtime/decision-router.ts`

### 应该放什么

- 按 `AgentDecision.type` 路由不同处理路径

### 实现步骤

1. 处理 `final_answer`
2. 处理 `tool_calls`
3. 处理 `ask_user`
4. 处理 `blocked`

### 验收标准

- 不同决策路径不再散在 Harness 的多个分支中

---

## 14. `model/model-gateway.ts`

### 应该放什么

- 统一模型调用入口
- 与 `provider` 对接

### 不应该放什么

- 主循环
- tool 执行

### 实现步骤

1. 接收统一模型请求对象
2. 调用 provider
3. 返回标准化模型结果
4. 调用 `ModelCompatibilityStrategy`

### 验收标准

- Harness 完全不需要感知具体 provider 细节

---

## 15. `model/decision-parser.ts`

### 应该放什么

- 将模型标准化响应转成 `AgentDecision`

### 实现步骤

1. 识别 final answer
2. 识别 tool calls
3. 识别 ask user
4. 识别 blocked
5. 生成统一 `AgentDecision`

### 验收标准

- 上层只消费 `AgentDecision`

---

## 16. `model/model-compatibility-strategy.ts`

### 应该放什么

- 模型行为兼容逻辑

### 实现步骤

1. 定义策略接口
2. 定义默认 no-op 策略
3. 预留修复入口：
   - tool args repair
   - empty response handling
   - finish normalization

### 验收标准

- 兼容逻辑不写进 Harness

---

## 17. `tools/tool-registry.ts`

### 应该放什么

- tool 的注册与查询

### 实现步骤

1. 注册 tool descriptor
2. 查询 tool
3. 按作用域返回可用工具列表
4. 输出模型可见 schema

### 验收标准

- tool 不再散落式硬编码

---

## 18. `tools/tool-executor.ts`

### 应该放什么

- 统一工具执行流程

### 实现步骤

1. 接收合法 `ToolInvocation`
2. 执行超时控制
3. 调用实际 executor
4. 标准化返回 `ToolExecutionResult`

### 验收标准

- 不同工具的结果结构一致

---

## 19. `tools/tool-runtime.ts`

### 应该放什么

- 工具事务层总控

### 实现步骤

1. 从 registry 解析工具
2. 校验参数
3. 调用 PermissionEngine
4. 调用 SandboxManager
5. 调用 ToolExecutor
6. 生成 observation
7. 返回 `ToolRuntimeResult`

### 验收标准

- 所有工具执行路径统一走这层

---

## 20. `permissions/permission-engine.ts`

### 应该放什么

- 工具权限判定逻辑

### 实现步骤

1. 输入 invocation 与上下文
2. 执行策略判断
3. 输出 `PermissionDecision`

### 验收标准

- 权限判断不写在工具内部

---

## 21. `sandbox/sandbox-manager.ts`

### 应该放什么

- sandbox profile 选择
- sandbox 会话获取

### 实现步骤

1. 根据 tool 和会话选择 profile
2. 创建或获取 sandbox handle
3. 返回统一执行环境

### 验收标准

- sandbox 逻辑与工具业务逻辑解耦

---

## 22. `memory/context-builder.ts`

### 应该放什么

- 构建 `StepContext`

### 实现步骤

1. 收集 recent messages
2. 注入 summary
3. 注入 relevant memories
4. 注入 tools 与 constraints

### 验收标准

- 模型输入来源清晰统一

---

## 23. `memory/context-compressor.ts`

### 应该放什么

- 上下文压缩与 tool payload compacting

### 实现步骤

1. 检测压缩触发条件
2. 选出可压缩区间
3. 生成 summary 或 compact 结果
4. 返回压缩后上下文

### 验收标准

- 多轮任务上下文可控

---

## 24. `memory/summary-manager.ts`

### 应该放什么

- session summary 的生成与更新

### 实现步骤

1. 读取已有 summary
2. 根据当前 step 增量更新
3. 输出新的 `SummarySnapshot`

### 验收标准

- summary 不再是随意拼接的字符串

---

## 25. `memory/memory-manager.ts`

### 应该放什么

- memory 检索、候选提取、持久化协调

### 实现步骤

1. 检索相关 memory
2. 提取候选
3. 调用 write policy
4. 落库并回传写入结果

### 验收标准

- memory 不再是“谁想写就写”

---

## 26. `memory/memory-store.ts`

### 应该放什么

- MemoryEntry 的底层存取接口

### 实现步骤

1. 提供 `save`
2. 提供 `query`
3. 提供 `update`
4. 提供 `touch lastUsedAt`

### 验收标准

- memory 有统一持久化抽象

---

## 27. `termination/termination-policy.ts`

### 应该放什么

- 结束判定策略

### 实现步骤

1. 检查 success
2. 检查 budget
3. 检查 stall
4. 检查 blocked
5. 返回 `TerminationDecision`

### 验收标准

- `final_answer` 不再等于直接 finished

---

## 28. `hooks/hook-kernel.ts`

### 应该放什么

- hook 注册、调度、异常隔离

### 实现步骤

1. 定义生命周期
2. 注册 hook
3. 顺序执行 hook
4. 合并 patch
5. 处理插件异常

### 验收标准

- 扩展点清晰，但主流程不被 hook 接管

---

## 29. `events/event-bus.ts`

### 应该放什么

- 统一事件发射与订阅

### 实现步骤

1. 定义 `RuntimeEvent`
2. 实现 emit
3. 实现 subscribe
4. 约定事件类型

### 验收标准

- trace / logging / UI 更新不耦合到主流程

---

## 30. `persistence/checkpoint-store.ts`

### 应该放什么

- run 和 step 的 checkpoint 读写抽象

### 实现步骤

1. 保存 run 快照
2. 保存 step 快照
3. 加载最近快照

### 验收标准

- 以后可以支持 resume，不需要重写 runtime 核心

---

## 31. 实现检查清单

这一节可以直接拿去做开发 checklist。

### 31.1 核心类型完成检查

- 已定义 `AgentRun`
- 已定义 `StepState`
- 已定义 `AgentDecision`
- 已定义 `ToolInvocation`
- 已定义 `MemoryEntry`

### 31.2 Runtime 完成检查

- `AgentRuntime` 对外入口完成
- `RunStateMachine` 已生效
- `Harness` 主循环完成

### 31.3 Tool 层完成检查

- 所有工具走 `ToolRuntime`
- 有独立权限判断
- 有独立 sandbox 选择

### 31.4 Context / Memory 完成检查

- 有统一 `StepContext`
- 有 summary
- 有基础 memory 检索与持久化

### 31.5 Termination 完成检查

- success / budget / stall / blocked 都可判定

### 31.6 Hook / Plugin 完成检查

- 有生命周期
- 有异常隔离
- 不破坏主流程

## 32. 本文件结论

这份文件的作用是把架构设计真正压到“按文件怎么拆、每个文件要实现什么”的粒度。

后续如果你开始正式编码，建议优先以本文件作为任务拆分依据，然后再回看：

- `07-core-types-and-interface-drafts.md`
- `08-runtime-sequence-and-state-contracts.md`

这三份一起看，已经足够进入实现阶段。

