# 04. 上下文构建、压缩、记忆与结束判定

本文件解决三类最容易在 agent runtime 中失控的问题：

1. 上下文越来越长，模型越来越不稳定
2. 什么信息应该被记住，什么不应该
3. 什么时候真正可以结束任务

如果这三件事不独立设计，后面会出现：

- 上下文爆炸
- 记忆污染
- 无限循环
- 口头上“完成了”，实际上没有完成

## 1. ContextBuilder 需要实现什么

ContextBuilder 的职责是：为每一轮 step 构建“最适合这轮决策的上下文”。

它不是简单把历史消息全部拼起来，而是要做主动筛选和分层组织。

### 1.1 ContextBuilder 的输入

至少包括：

- 当前用户目标
- 最近对话
- 最近 observation
- 当前 session summary
- relevant memory
- 当前 tools
- 当前权限与环境约束

### 1.2 ContextBuilder 的输出

输出应该是统一的 `StepContext` 或 `ModelContext`，包含：

- `systemInstructions`
- `goalSection`
- `recentHistory`
- `summarySection`
- `relevantMemorySection`
- `toolsSection`
- `constraintsSection`

### 1.3 为什么必须单独做这一层

因为“喂给模型什么”是 agent 效果最关键的一环。

如果把上下文构建散落在：

- memory 模块里加一点
- hook 里加一点
- tool runtime 里加一点

那么后面你很难推断模型为什么做出某个决定。

## 2. 上下文必须分层，而不是一坨消息

建议每轮上下文拆成 4 层：

### 2.1 Working Window

这是最近几轮的详细消息和 observation。

作用：

- 保留当前任务最细的局部上下文
- 让模型知道最近刚发生了什么

### 2.2 Session Summary

这是当前任务到此为止的阶段性摘要。

作用：

- 让模型理解“已经做过什么”
- 避免旧历史全部原样保留

### 2.3 Relevant Memory

这是从长期记忆中动态检索出来的少量信息。

作用：

- 注入长期偏好
- 注入项目规则
- 注入高价值历史经验

### 2.4 Constraints and Tools

包括：

- 当前可用 tools
- tool 使用限制
- 当前 sandbox / permission 约束
- 运行预算

作用：

- 让模型知道它“能做什么”和“不能做什么”

## 3. ContextCompressor 需要实现什么

压缩不是“上下文太长就删一些”，而是要系统地做上下文治理。

### 3.1 触发压缩的条件

至少要支持下面几种触发方式：

- `token threshold`
  - 上下文接近模型窗口上限时触发

- `step threshold`
  - 达到若干轮后触发

- `event trigger`
  - 完成一个子任务后触发
  - 一次大型工具链结束后触发
  - 一次超大输出出现后触发

### 3.2 压缩不能压掉什么

下面这些内容不能轻易被 summary 替代：

- 当前用户目标
- 当前系统指令
- 最近的关键 observation
- 当前未解决 blocker
- 当前正在等待的 approval / input

### 3.3 压缩可以处理什么

适合压缩的内容包括：

- 很早之前的多轮执行过程
- 已经完成的子任务细节
- 旧的 tool arguments
- 很长的 tool result
- 冗长但无增量价值的日志

### 3.4 压缩的动作

建议至少支持这 4 个动作：

#### 3.4.1 Sliding Window

保留最近 N 轮详细消息。

#### 3.4.2 Summarization

将更早的历史压成 session summary。

#### 3.4.3 Tool Payload Compacting

压缩旧 tool result 或旧 tool args，只保留摘要和关键字段。

#### 3.4.4 History Offload

将被压掉的原始历史存到外部存储，供回放和审计使用。

### 3.5 为什么不能只保留 summary

如果全部靠 summary，很容易出现：

- 模型失去最近执行上下文
- 再次重复调用工具
- 无法利用最近失败的细节

因此必须采用“最近窗口 + summary”的双层结构。

## 4. SummaryManager 需要实现什么

SummaryManager 不只是“把消息总结一下”。

它要生成的是“继续执行任务所需的状态性摘要”。

### 4.1 summary 应包含什么

建议至少包括：

- 原始任务目标
- 已完成的关键步骤
- 当前已知事实
- 当前未解决问题
- 已知失败原因
- 当前约束条件

### 4.2 summary 不应包含什么

不要堆积：

- 大段原始日志
- 大段工具原始输出
- 一次性临时值
- 与后续决策无关的细枝末节

### 4.3 summary 的更新时机

建议：

- 子目标完成后更新
- 上下文接近上限时更新
- 多轮执行后定期更新
- 任务结束前做最终任务摘要

## 5. MemoryManager 需要实现什么

MemoryManager 负责长期记忆相关的编排，而不是直接存数据库。

### 5.1 它必须负责的事情

- 每轮开始前检索相关 memory
- 每轮结束后提取 memory candidate
- 判断 candidate 是否值得保存
- 将有效记忆写入 `MemoryStore`
- 更新记忆的使用频率和最后使用时间

### 5.2 它不应该做的事情

不应该：

- 直接决定整个任务是否结束
- 直接实现数据库或向量库驱动
- 直接拼接 prompt 字符串作为唯一职责

## 6. MemoryStore 建议的数据类型

不要一开始就只存“纯文本记忆”，建议从第一版就结构化。

### 6.1 MemoryEntry 必须包含的字段

- `memoryId`
- `type`
- `scope`
- `content`
- `summary`
- `tags`
- `importance`
- `confidence`
- `ttl`
- `sourceRunId`
- `createdAt`
- `lastUsedAt`

### 6.2 建议支持的 memory type

- `profile`
  - 用户长期偏好、输出风格、行为偏好

- `procedural`
  - 工作流、命令、项目规则、工具用法

- `episodic`
  - 某次执行中发现的重要事实或经验

- `artifact`
  - 某个关键文件、报告、日志、结果产物的索引

### 6.3 为什么要结构化

因为后续需要：

- 按类型筛选
- 按 tags 检索
- 按重要度排序
- TTL 过期
- conflict merge

## 7. MemoryWritePolicy 需要实现什么

MemoryWritePolicy 决定“哪些 observation 值得进入长期记忆”。

### 7.1 必须考虑的判断维度

- 是否是长期稳定信息
- 是否对未来有复用价值
- 是否获取成本很高
- 是否只是一次性临时状态
- 是否包含敏感信息
- 是否与已有记忆重复

### 7.2 什么时候应该写入 memory

建议写入：

- 用户明确要求记住的信息
- 用户长期偏好
- 项目规则和稳定工作流
- 高成本获取的重要事实
- 可复用失败经验

### 7.3 什么时候不应该写入

不建议写入：

- 一次性的中间变量
- 临时状态
- 原始长日志
- 未验证的猜测
- 可能很快过时的信息

## 8. 动态记忆写入流水线

不要让模型一句“这个值得记住”就直接写入。

建议实现下面的流水线：

```text
Observation / Final Answer / User Feedback
-> Candidate Extractor
-> Candidate Scorer
-> Dedup / Merge
-> Policy Check
-> Persist
```

### 8.1 Candidate Extractor

职责：

- 从 observation 中提取稳定事实
- 从用户反馈中提取偏好
- 从失败中提取经验

### 8.2 Candidate Scorer

职责：

- 判断候选记忆的重要度和置信度

### 8.3 Dedup / Merge

职责：

- 与已有记忆对比
- 决定是跳过、更新、还是新建

### 8.4 Policy Check

职责：

- 执行 MemoryWritePolicy

### 8.5 Persist

职责：

- 写入 MemoryStore

## 9. 动态记忆检索

Memory 的价值不在于“存了很多”，而在于“每轮只取最相关的一小部分”。

### 9.1 检索输入

建议基于：

- 当前任务目标
- 当前 step 状态
- 当前工具计划
- 当前项目范围

### 9.2 检索方式

一期可以先支持：

- tag 筛选
- 关键字匹配
- 最近使用优先
- 类型过滤

后续再支持 embedding 检索。

### 9.3 注入上下文的方式

不要把记忆注入成大段散文，建议结构化地注入：

- 用户偏好：中文简洁输出
- 项目规则：使用 pnpm，不使用 npm
- 已知约束：测试依赖 mock server
- 过往经验：某命令在 workspace root 下执行

## 10. TerminationPolicy 需要实现什么

TerminationPolicy 用来解决“什么时候真正可以停”的问题。

### 10.1 为什么必须独立存在

因为模型常见的问题包括：

- 说自己完成了，但实际上没有完成
- 被卡住后仍然继续空转
- 没有新信息还不断重复尝试

因此 runtime 必须有自己的结束判定。

### 10.2 TerminationPolicy 的输入

建议至少包括：

- `run`
- `lastStepResult`
- `budgetUsage`
- `unresolvedBlockers`
- `currentSummary`

### 10.3 TerminationPolicy 的输出

建议统一为：

- `continue`
- `finish`
- `ask_user`
- `fail`

### 10.4 至少要支持的终止类型

#### 10.4.1 SuccessTermination

任务目标已满足，必要输出已经具备。

#### 10.4.2 BudgetTermination

步数、工具调用数、时间、token 达到上限。

#### 10.4.3 StallTermination

检测到空转，例如：

- 连续几轮没有新事实
- 重复相同工具调用
- 连续失败且没有新策略

#### 10.4.4 BlockedTermination

任务继续推进需要外部条件，但当前无法满足，例如：

- 缺权限
- 缺关键输入
- 关键工具不可用

#### 10.4.5 HumanHandoffTermination

适合转人工处理。

## 11. 一轮 step 中 context / memory / termination 的执行顺序

推荐顺序如下：

1. 读取最近历史
2. 读取当前 summary
3. 检索 relevant memory
4. 构建 step context
5. 如有必要，先做压缩
6. 调模型
7. 如果有 tool results，生成 observation
8. 提取 memory candidate
9. 更新 summary
10. 运行 termination policy

这一顺序的关键点在于：

- 检索 memory 在模型调用前
- 写 memory 在 step 完成后
- termination 在 tool observation 和 summary 更新之后

## 12. 一期建议怎么做

### 12.1 一期必须做的

- `ContextBuilder`
- `SummaryManager`
- 基础 `ContextCompressor`
- 结构化 `MemoryEntry`
- 基础 `MemoryWritePolicy`
- 基础 `TerminationPolicy`

### 12.2 一期可以先不做复杂化

可以先不做：

- embedding 检索
- 向量数据库
- 复杂冲突消解
- 自动长期知识图谱

先把“最近窗口 + summary + 少量结构化 memory + 基础 termination”跑通最重要。

## 13. 本文件结论

这一层最终要形成的是：

- `ContextBuilder`：每轮该看什么
- `ContextCompressor`：上下文长了怎么处理
- `MemoryManager`：长期信息如何读写
- `TerminationPolicy`：任务什么时候真正停止

这四块是 agent 从“能循环”走向“可长期稳定执行”的核心。

