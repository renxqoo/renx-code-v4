# 05. Hook、Middleware、模型兼容与插件体系

本文件专门回答两个容易混淆的问题：

1. hook / middleware 到底该做什么，不该做什么
2. 模型兼容逻辑到底放在哪一层

这是为了避免后续架构走向两个极端：

- 极端 A：所有事情都写进 Harness，导致核心越来越脏
- 极端 B：所有事情都写成 hook，导致主流程越来越看不清

## 1. 基本结论

### 1.1 Harness 不是 hook

Harness 是核心编排层。

### 1.2 hook 不是主流程

hook / middleware 是 Harness 暴露出去的扩展点。

### 1.3 模型兼容不应写进 Harness

模型行为兼容逻辑应该放在：

- `ModelCompatibilityStrategy`
- 或专门的 compatibility middleware

而不是写进 Harness 主循环。

## 2. 为什么不能把 Harness 通过 hook 实现

如果把 Harness 本身写成一组 hook，会出现以下问题：

### 2.1 控制流隐式

你很难一眼看出：

- 一轮 step 的开始点
- tool 事务发生在哪里
- memory 什么时候更新
- termination 什么时候检查

### 2.2 状态机边界模糊

一旦加入：

- waiting_permission
- paused
- resume
- failed

状态切换需要一个中心控制器，不能靠多个 hook 各自修改状态。

### 2.3 插件与核心责任混淆

如果 Harness 自己就是 hook，那么外部插件与核心 runtime 就会在同一层争抢控制权。

## 3. HookKernel 需要实现什么

HookKernel 是插件扩展的容器和调度器。

### 3.1 它的职责

- 注册 hook / middleware
- 定义统一生命周期
- 控制 hook 调用顺序
- 收集 hook 产生的 patch / metadata
- 隔离插件错误，不让插件轻易拖垮主流程

### 3.2 它不应该做什么

不应该：

- 直接承担主状态机
- 直接推进 ReAct loop
- 直接决定任务 finished

## 4. 建议的 hook 生命周期

下面这组生命周期是推荐的最小集合。

### 4.1 Run 生命周期

- `beforeRun`
- `afterRunStart`
- `beforeFinish`
- `afterFinish`
- `onRunError`

### 4.2 Step 生命周期

- `beforeStep`
- `afterStep`

### 4.3 Context 生命周期

- `beforeBuildContext`
- `afterBuildContext`

### 4.4 Model 生命周期

- `beforeModelCall`
- `afterModelCall`
- `onModelError`

### 4.5 Tool 生命周期

- `beforeToolExecution`
- `afterToolExecution`
- `onToolError`

### 4.6 Memory 生命周期

- `beforePersistMemory`
- `afterPersistMemory`

## 5. hook 允许做什么

hook 可以做：

- 记录日志
- 记录 trace
- 注入 metadata
- 对上下文做轻量补充
- 对模型响应做轻量 patch
- 对 tool result 做脱敏
- 注册额外工具
- 发 metrics

## 6. hook 不允许做什么

原则上不应该让 hook 直接做下面这些事：

- 直接把 run 状态切到 `finished`
- 绕过权限系统直接执行工具
- 直接写 MemoryStore 底层
- 直接改动主循环结构

如果插件真的需要强控制权，应该通过：

- 注册策略对象
- 覆盖某个可配置组件

而不是在 hook 里偷偷改状态。

## 7. Middleware 与 Hook 的关系

这里建议把“hook”理解成生命周期点，把“middleware”理解成以这些生命周期为基础的一种实现方式。

换句话说：

- Hook 是时机
- Middleware 是实现形式

你可以允许插件以 middleware 形式挂在 HookKernel 上，但核心仍然按统一生命周期来驱动。

## 8. 模型兼容层需要实现什么

你前面已经明确说，不想把“某些模型需要容错，某些不需要”的逻辑塞进 Harness。

这个判断是对的。

### 8.1 模型兼容层的职责

建议命名为 `ModelCompatibilityStrategy`，它负责：

- 修复某些模型的 tool args 输出问题
- 处理空响应或不完整响应
- 调整某些模型的 prompt 形状
- 处理某些模型不稳定的结束信号
- 在必要时给出 fallback 建议

### 8.2 它不负责什么

不负责：

- HTTP 协议适配
- provider 原始请求构造
- retry 的通用实现
- 主循环编排

这些要留在 `provider` 或 `runtime` 的其他层中。

## 9. Adapter 与 ModelCompatibilityStrategy 的边界

这是最重要的一条边界之一。

### 9.1 Adapter 解决什么

Adapter 解决：

- 请求字段映射
- 响应字段解析
- 错误映射
- streaming chunk 归一化

它解决的是“怎么和这个厂商说话”。

### 9.2 ModelCompatibilityStrategy 解决什么

它解决：

- 这个模型的输出行为哪里不稳定
- 哪些场景需要额外修复
- 哪些模型更适合提前 summary
- 某模型 tool calling 不可靠时如何降级

它解决的是“这个模型怎么用更稳”。

### 9.3 Harness 解决什么

Harness 解决：

- 当前任务怎么推进
- 什么时候调模型
- 什么时候调工具
- 什么时候结束

它解决的是“任务怎么跑”。

## 10. 插件体系需要允许哪些扩展

建议第一版先只开放这 4 类扩展：

### 10.1 Hook 扩展

用于日志、trace、脱敏、统计。

### 10.2 Tool 扩展

允许插件向 ToolRegistry 注册工具。

### 10.3 Policy 扩展

允许插件提供新的：

- permission policy
- memory write policy
- termination policy
- model compatibility strategy

### 10.4 Context 扩展

允许插件对 context 进行可控增强。

## 11. 插件边界与安全要求

因为你计划支持外部 hook 插件，这里一定要有边界。

### 11.1 插件不能默认拥有核心可变状态

插件不应该直接拿到内部可变对象引用，然后随意修改。

更安全的做法是：

- 读：给 snapshot
- 写：返回 patch 或明确指令

### 11.2 插件错误隔离

建议 HookKernel 提供策略：

- 核心插件失败：中止或降级
- 非核心插件失败：记录错误但不阻断主流程

### 11.3 插件审计

建议至少记录：

- 哪个插件被触发
- 在哪个生命周期触发
- 是否产生 patch
- 是否抛错

## 12. 一期建议如何实现这一层

### 第一步：先定生命周期

不要先写插件代码，先把固定生命周期列清楚。

### 第二步：写 HookKernel

要求：

- 能注册多个 hook
- 能控制执行顺序
- 能合并 patch
- 能隔离异常

### 第三步：写 ModelCompatibilityStrategy 接口

要求：

- provider 和 Harness 都不直接感知某个模型的特殊兼容逻辑

### 第四步：把常见兼容逻辑迁到 compatibility 层

例如：

- tool args repair
- empty response handling
- unstable finish normalization

## 13. 本文件结论

这一层最终要形成的结构应该是：

- `Harness`：核心编排
- `HookKernel`：扩展入口
- `ModelCompatibilityStrategy`：模型行为兼容
- `PluginRegistry`：插件注册中心

换句话说：

不是“用 hook 实现 Harness”，
而是“Harness 提供 hook，兼容逻辑和插件扩展通过 hook / strategy 接入”。

