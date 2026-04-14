# 06. 实施路线图与阶段验收

本文件的目标不是列一个“愿望清单”，而是把这套架构拆成可以逐步落地的实现阶段。

每个阶段都回答三件事：

1. 这阶段必须实现什么
2. 这阶段不要做什么
3. 这阶段完成后如何验收

## 1. 总体实施原则

### 1.1 先打通主链路，再做复杂能力

最重要的主链路是：

```text
Runtime
-> Harness
-> ReActLoop
-> Decision
-> ToolRuntime
-> Observation
-> Memory / Summary
-> Termination
```

如果这条主链没有稳定打通，就不要急着做高级 memory、复杂插件、复杂 subagent。

### 1.2 一期先追求“稳定可控”

第一阶段的目标不是“最聪明”，而是：

- 状态明确
- 边界清楚
- 可恢复
- 可调试

## 2. 阶段一：最小可运行 Runtime

### 2.1 目标

让系统具备一个完整但最小的 agent 执行闭环。

### 2.2 这一阶段必须实现

#### 2.2.1 AgentRuntime

必须提供：

- 创建 run
- 启动 run
- 查询 run
- 返回 run 结果

#### 2.2.2 Harness

必须提供：

- `runUntilStop`
- `runSingleStep`
- `dispatchDecision`

#### 2.2.3 RunStateMachine

至少支持：

- `ready`
- `running`
- `finished`
- `failed`
- `cancelled`

#### 2.2.4 ReActLoopEngine

必须能够：

- 构建单轮请求
- 调模型
- 解析为 `AgentDecision`

#### 2.2.5 DecisionRouter

至少支持：

- `final_answer`
- `tool_calls`

### 2.3 这一阶段暂时不要做

先不要做：

- 复杂 memory store
- 复杂 approval 流
- 复杂 sandbox provider
- 复杂 hook 插件体系
- embedding 检索

### 2.4 阶段一验收标准

达到下面这些才算完成：

1. 用户输入一个任务后，系统可以执行多轮 step
2. 模型返回 `tool_calls` 时，可以进入工具执行分支
3. 工具结果能写回 observation 并继续下一轮
4. 模型返回 `final_answer` 时，可以正常结束
5. run 状态能从 `ready -> running -> finished/failed`

## 3. 阶段二：ToolRuntime、权限与基础 sandbox

### 3.1 目标

把工具执行从 Harness 中彻底抽离成独立事务层。

### 3.2 这一阶段必须实现

#### 3.2.1 ToolRegistry

必须支持：

- 注册工具
- 查询工具
- 输出模型可见 schema

#### 3.2.2 ToolExecutor

必须支持：

- 参数校验
- 统一执行
- timeout
- 标准化结果

#### 3.2.3 PermissionEngine

必须支持：

- `allow`
- `deny`
- `ask`

#### 3.2.4 SandboxManager

一期至少支持固定 profile：

- `read_only`
- `workspace_write`
- `network_disabled`

### 3.3 这一阶段暂时不要做

先不要做：

- 多 provider sandbox 自动切换
- 太复杂的基于历史行为的权限评分
- 复杂 distributed execution

### 3.4 阶段二验收标准

达到下面这些才算完成：

1. tool invocation 可以被结构化描述
2. tool 执行前会统一走权限判断
3. `ask` 可以把 run 切到等待状态
4. 不同工具可挂不同 sandbox profile
5. tool result 能统一格式回写 observation

## 4. 阶段三：上下文治理与基础 memory

### 4.1 目标

解决上下文膨胀与任务执行过程中知识沉淀的问题。

### 4.2 这一阶段必须实现

#### 4.2.1 ContextBuilder

必须支持：

- 最近窗口
- summary 注入
- memory 注入
- 当前工具和约束注入

#### 4.2.2 ContextCompressor

必须支持：

- token 阈值触发
- step 阈值触发
- 旧历史 summary
- 旧 tool result 压缩

#### 4.2.3 SummaryManager

必须能维护一个阶段性摘要。

#### 4.2.4 MemoryStore

一期先支持结构化存储即可，不必复杂。

#### 4.2.5 MemoryWritePolicy

必须能筛掉低价值候选记忆。

### 4.3 这一阶段暂时不要做

先不要做：

- 知识图谱
- 太复杂的自动推理写入
- 高级向量数据库优化

### 4.4 阶段三验收标准

达到下面这些才算完成：

1. 多轮执行后上下文长度可控
2. session summary 可更新
3. 高价值 observation 可沉淀到 memory
4. 下一轮能取回相关 memory 参与上下文构建

## 5. 阶段四：完整 termination、approval 和恢复能力

### 5.1 目标

让 runtime 真正具备“生产可控”的运行特性。

### 5.2 这一阶段必须实现

#### 5.2.1 TerminationPolicy

至少支持：

- success
- budget exceeded
- stall
- blocked

#### 5.2.2 Waiting Permission / Waiting Input 恢复

run 可以从等待状态恢复。

#### 5.2.3 Step 级 checkpoint

至少在关键节点持久化：

- decision
- pending invocation
- summary
- memory updates

### 5.3 阶段四验收标准

达到下面这些才算完成：

1. 工具审批后可恢复执行
2. 输入补充后可恢复执行
3. 空转可以被 termination policy 识别
4. 任务失败时能看见明确错误分类

## 6. 阶段五：Hook / Middleware / Plugin 体系

### 6.1 目标

让系统可扩展，而不是只能靠改核心代码增加能力。

### 6.2 这一阶段必须实现

#### 6.2.1 HookKernel

必须支持：

- 注册 hook
- 固定生命周期
- 顺序控制
- 异常隔离

#### 6.2.2 PluginRegistry

至少支持注册：

- hook
- tool
- policy

#### 6.2.3 ModelCompatibilityStrategy

把模型行为兼容从 Harness 主路径里剥离出来。

### 6.3 阶段五验收标准

达到下面这些才算完成：

1. 不改 Harness 主代码也能扩展行为
2. 特定模型兼容逻辑可独立挂载
3. 插件失败不会直接把主流程搞崩

## 7. 推荐实施顺序的具体清单

这一节按更细的“开发任务清单”来写，方便你真的开工。

### 第 1 步：先定义领域对象

必须先定义：

- `AgentRun`
- `StepState`
- `AgentDecision`
- `ToolInvocation`
- `ToolExecutionResult`
- `MemoryEntry`

原因：

- 没有统一领域对象，后续每一层都会传不一致的数据结构

### 第 2 步：实现 RunStateMachine

原因：

- 没状态机，后面 approval 和 resume 很难接

### 第 3 步：实现 Harness 主循环

原因：

- 这是所有能力的落脚点

### 第 4 步：实现 ReActLoopEngine + DecisionParser

原因：

- 必须先形成统一决策对象，后面才能做工具执行和 termination

### 第 5 步：接入最小 ToolRuntime

原因：

- 没有工具分支，agent 只是一个对话机器人，不是执行型 agent

### 第 6 步：实现基础 ContextBuilder 与 SummaryManager

原因：

- 多轮执行一开始就会遇到上下文问题

### 第 7 步：实现基础 TerminationPolicy

原因：

- 没结束判定，很快就会遇到空转问题

### 第 8 步：实现基础 MemoryManager

原因：

- 让系统开始具备“记住高价值信息”的能力

### 第 9 步：再引入 HookKernel 和 Plugin

原因：

- 主流程没稳定前做扩展，容易把复杂度提前放大

## 8. 各阶段的完成定义

这里给出比较硬的“完成定义”，避免开发过程中误以为“能跑就算完成”。

### 阶段一完成定义

- 有统一 run 对象
- 有统一 decision 对象
- 有显式 run state
- 能从任务开始跑到结束

### 阶段二完成定义

- 所有工具执行都经过 ToolRuntime
- 权限判断与 sandbox 选择不散落在工具里

### 阶段三完成定义

- 上下文不会无限膨胀
- memory 开始具备结构化能力

### 阶段四完成定义

- 支持等待与恢复
- 支持空转终止
- 支持 step 级 checkpoint

### 阶段五完成定义

- 可插拔扩展生效
- 主流程不因插件而失控

## 9. 最后建议

实现顺序一定要稳，不要一开始就同时做：

- 多 agent
- 向量检索
- 高级插件系统
- 多 sandbox provider

最优先的是先把这条链打稳：

```text
Harness
-> ReActLoop
-> ToolRuntime
-> Observation
-> Summary
-> Termination
```

只要这条链稳定，后面你再加：

- memory
- plugin
- subagent
- harness agent

都会容易很多。

## 10. 本文件结论

推荐的实际落地顺序是：

1. 领域对象
2. 状态机
3. Harness
4. ReActLoop
5. ToolRuntime
6. Context / Summary
7. Termination
8. Memory
9. Hook / Plugin

先做稳定的可控 runtime，再做复杂的高级能力。

