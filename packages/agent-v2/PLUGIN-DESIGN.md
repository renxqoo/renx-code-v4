# Plugin 机制：用代码说话

## 一句话总结

> **Plugin = 改 input 或 包 output 的高阶函数。agent() 只有一处读 Plugin 注入的东西：执行工具前读 `input.onTools`。**

---

## 第一步：agent() 内部长什么样

```typescript
async function* agent(input: AgentInput): AgentGenerator {

  let state = initState(input)
  yield { type: "run:started" }

  while (state.stepCount < maxSteps) {

    // ============ LLM 调用 ============
    const llmGen = input.llmClient.stream({ model, messages: state.messages, tools })
    let text = ""; let toolCalls = []

    for await (const chunk of llmGen) {
      if (chunk.type === "text-delta") {
        text += chunk.delta
        yield { type: "llm:delta", delta: chunk.delta }
      }
      // 累积 tool calls...
    }

    if (llmResult.finishReason === "stop") {
      // 最终答案，结束
      yield { type: "run:finished", outcome: buildResult(state, text) }
      return
    }

    // ============ 工具执行前 ============
    // ★★★ 这里就是 agent() 和 Plugin 的唯一接触点 ★★★
    if (input.onTools) {
      const decision = await input.onTools({
        toolCalls: toolCalls.map(tc => ({ id: tc.id, name: tc.name, args: tc.args })),
        state,
        priorApprovals: ctx.priorApprovals,  // ← 来自 InternalRunContext.resumeApprovals
      })

      if (decision.action === "abort") {
        yield { type: "run:finished", outcome: buildResult(state, text) }
        return
      }
      if (decision.action === "deny") {
        // 拒绝部分工具，只执行未被拒的
        toolCalls = filterDenied(toolCalls, decision.callIds)
      }
      if (decision.action === "pause") {
        // 暂停信号：agent() 终止，RunManager 保存状态 + 等待恢复
        yield { type: "pause:approval", runId: state.runId, callIds: decision.callIds, tools: decision.callIds.map(cid => getCallName(cid)), arguments: decision.callIds.map(cid => getCallArgs(cid)) }
        return
      }
    }

    // ============ 执行工具 ============
    state.messages.push(assistant(toolCalls))
    for (const tc of toolCalls) {
      yield { type: "tool:start", callId: tc.id, name: tc.name }
      const result = await executeTool(tc, ctx)
      yield { type: "tool:result", callId: tc.id, output: result }
      state.messages.push(toolResult(tc.id, result))
    }

    state.stepCount++
  }

  yield { type: "run:finished", outcome: buildResult(state) }
}
```

`input.onTools` 就是全部注入点。agent() 不关心是谁设置了这个回调。

---

## 第二步：Plugin 是什么

Plugin 就是一层**函数包裹**。它接收一个 agent 函数，返回一个新的 agent 函数。在中间可以改 input、可以截事件。

```typescript
type Plugin = (
  next: (input: AgentInput) => AgentGenerator
) => (input: AgentInput) => AgentGenerator
```

---

## 第三步：日志 Plugin（纯观察，不改 input）

```typescript
function withLogging(logger: Logger): Plugin {
  return (next) =>
    async function* (input) {
      const start = Date.now()
      logger.info("run:start", { runId: input.runId })

      for await (const event of next(input)) {  // ← 直接传原 input
        logger.debug("event", event.type)
        yield event
      }

      logger.info("run:end", { duration: Date.now() - start })
    }
}
```

一层 for-await 包一下。什么都没改。

---

## 第四步：审批 Plugin（改 input）

审批 Plugin 通过**修改 input 传入 onTools 回调**来介入 agent 内部。

```typescript
function withApproval(opts: { approve: ApproveFn }): Plugin {
  return (next) =>
    async function* (input) {

      // ★ 构造一个新的 input，注入 onTools
      const guardedInput: AgentInput = {
        ...input,
        onTools: createToolGuard(input, opts.approve),
      }

      yield* next(guardedInput) // ← 把改过的 input 传给下一层
    }
}

function createToolGuard(originalInput: AgentInput, approve: ApproveFn) {
  return async (ctx: ToolDecisionContext): Promise<ToolDecision> => {

    // 情况 A：这是恢复运行，RunManager 已经把审批结果放进 input 了
    if (ctx.priorApprovals) {
      const deniedIds = ctx.priorApprovals
        .filter(a => a.action === "deny").map(a => a.callId)
      if (deniedIds.length > 0) {
        return { action: "deny", callIds: deniedIds, reason: "Denied" }
      }
      return { action: "execute" }
    }

    // 情况 B：首次运行，调用外部审批函数
    const result = await approve(ctx.toolCalls)

    if (result.action === "allow" || result.action === "execute") {
      return { action: "execute" }
    }
    if (result.action === "deny") {
      return { action: "deny", callIds: result.callIds, reason: "Denied" }
    }
    if (result.action === "abort") {
      return { action: "abort", reason: result.reason }
    }

    throw new Error("invalid approve result")
  }
}
```

---

## 第五步：暂停怎么处理

上面第四步中，`approve()` 是同步调用的。如果 `approve()` 需要等用户（异步），怎么办？

**不在 Plugin 层处理。在 RunManager 层处理。**

流程图：

```
用户代码
  │
  ▼
RunManager.stream()
  │
  │  调用 pipe(plugins, agent)(input)
  │  agent 内部: input.onTools(ctx) 被调用
  │  onTools 内部的 approve() 被调用
  │  approve 返回 "需要暂停"
  │
  ▼  onTools 返回 { action: "pause", callIds: [...], reason: "awaiting_approval" }
  │   agent() 产出一个 pause:approval 事件，然后 return 终止生成器
  │
  ▼  事件流中看到 pause:approval 事件
  │
  ▼  RunManager 检测到 pause:approval
  │   1. 保存当前 state 到 PersistenceAdapter
  │   2. 对外暴露 approve() / deny() 方法
  │
  ▼  用户调用了 approve(["call_1"])
  │
  ▼  RunManager:
  │   1. 从 adapter 加载保存的 state
  │   2. 构建新 input 和 InternalRunContext: { resumeApprovals: [{callId: "call_001", action: "allow"}] }
  │   3. 重新调用 pipe(plugins, agent)(newInput)
  │   4. agent 从头执行，到达同一个工具调用点
  │   5. input.onTools 再次被调用，这次 ctx.priorApprovals 有值
  │   6. onTools 返回 { action: "execute" }
  │   7. agent 执行工具，继续运行
```

关键是：**RunManager 杀掉旧 generator，用保存的状态 restart 新 generator**。

因为 agent() 是确定的（相同 input → 相同行为），所以 restart 是安全的。

---

## 第六步：怎么知道工具被"暂停"了还是"真被拒"了

增加一个事件类型来区分：

```typescript
// agent 内部，onTools 返回 deny 时：
if (decision.reason === "awaiting_approval") {
  yield {
    type: "control:pause",
    pauseType: "approval_required",
    toolCalls: ctx.toolCalls,
  }
  // 不追加 tool error messages，保持 messages 干净
  return  // 终止
}

// 如果是真的 deny（决定性的拒绝）：
// 正常追加 error messages，继续执行
```

或者更简单的方案：在 `onTools` 的返回类型中增加 pause：

```typescript
type ToolDecision =
  | { action: "execute" }
  | { action: "deny"; callIds: string[]; reason: string }
  | { action: "abort"; reason: string }
  | { action: "pause"; callIds: string[]; reason: string }
```

agent() 看到 `pause`：
```
if (decision.action === "pause") {
  yield { type: "control:pause", pauseType: "approval", callIds: decision.callIds }
  return
}
```

RunManager 看到 `control:pause` → 暂停 → 等待 → 重启。

---

## 完整串联：一次审批运行

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
第一次运行
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

用户调用: run = RunManager.create(input, myAgent)

RunManager 调用:
  myAgent(input)  ← 这等于 pipe(withApproval(approve), agent)(input)

withApproval 收到的 input 被它改写:
  input = { ...originalInput, onTools: createToolGuard(...) }

agent 收到的 input 含 onTools
agent 正常运行...

agent 内部:
  第 1 步: LLM 返回 tool_calls = [deploy_prod]

  执行工具前: input.onTools({ toolCalls: [deploy_prod], state, priorApprovals: undefined })

  createToolGuard 的逻辑:
    priorApprovals 是 undefined → 进入"首次运行"分支
    调用 approve([deploy_prod])
    approve 返回 { action: "pause" }
    → onTools 返回 { action: "pause", callIds: ["call_001"], reason: "Needs approval" }

  agent 收到 pause 决策:
    yield { type: "pause:approval", runId, callIds: ["call_001"], tools: ["deploy_prod"], arguments: [...] }
    return  ← 生成器终止

RunManager 检测到 pause:approval:
  1. adapter.saveState(state)         ← state.messages = [user, assistant(tool_calls)]
  2. 状态标记为 waiting_approval

用户的 for-await 循环:
  看到 control:pause 事件
  break

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
用户审批
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

run.approve(["call_001"])

RunManager:
  1. state = adapter.loadState(runId)
  2. newInput = {
       model: state.model,
       systemPrompt: state.systemPrompt,
       messages: state.messages,       // [user, assistant([deploy_prod])]
       tools: state.tools,
       stepCount: state.stepCount,     // = 1
       workingMemory: state.workingMemory,
     }
  3. InternalRunContext = { resumeApprovals: [{ callId: "call_001", action: "allow" }] }
  4. 重新调用 myAgent(newInput)  // agent() 内部实现合并 AgentInput & InternalRunContext → OnToolsContext.priorApprovals

withApproval 处理 newInput:
  再次注入 onTools (包含 createToolGuard)

agent 重新执行:
  从 state 恢复:
    messages 最后一个消息是 assistant([deploy_prod])
    LLM 调用被跳过，直接进入工具执行阶段

  执行工具前: input.onTools({
    toolCalls: [deploy_prod],
    state,
    priorApprovals: [{ callId: "call_001", action: "allow" }],
  })

  createToolGuard 的逻辑:
    priorApprovals 有值 → 进入"恢复"分支
    检查: 没有 denied → 返回 { action: "execute" }

  agent 收到 execute:
    执行 deploy_prod
    yield tool:start
    yield tool:result

  继续第 2 步:
    LLM 调用...
    llm:delta "Deployment successful"

  yield run:finished

用户的 for-await 循环 (第二次):
  看到 tool:start, tool:result, llm:delta, run:finished
```

---

## 总结：三层角色，两个字段

```typescript
// ── AgentInput（公开类型）──
type AgentInput = {
  // ...用户直接传的...

  // 1. 工具决策回调（Plugin 注入）
  onTools?: (ctx: OnToolsContext) => Promise<OnToolsDecision>
}

// ── OnToolsContext（onTools 回调接收的参数）──
type OnToolsContext = {
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[]
  state: RunState
  priorApprovals?: { callId: string; action: "allow" | "deny" }[]  // ← RunManager 注入
}

// ── InternalRunContext（内部类型，不对外暴露）──
type InternalRunContext = {
  resumeApprovals?: { callId: string; action: "allow" | "deny" }[]  // → OnToolsContext.priorApprovals
}

// ── OnToolsDecision（onTools 的返回值）──
type OnToolsDecision =
  | { action: "execute" }
  | { action: "deny";   callIds: string[]; reason: string }
  | { action: "abort";  reason: string }
  | { action: "pause";  callIds: string[]; reason: string }
```

**三角关系：**

```
  Plugin ──写──▶ input.onTools
                ▼
  agent() ──读──▶ input.onTools(ctx) → OnToolsDecision
                ▼
  RunManager ──写──▶ InternalRunContext.resumeApprovals → ctx.priorApprovals
                ▼
  onTools 内部 ──读──▶ ctx.priorApprovals

  其余一切（日志、过滤、超时）都在 agent() 的外层 for-await 里完成。
```

> **详细规格见 [DESIGN.md §4.2](./DESIGN.md#42-agent-生成器) AgentInput 完整定义、[DESIGN.md C.5](./DESIGN.md#c5-withapproval-plugin-的具体工作机制) 审批暂停流程、[DESIGN.md C.7](./DESIGN.md#c7-runmanagerstream-的多次消费实现) RunManager.stream() 实现。**
