/**
 * BaseAgent 伪代码
 *
 * 目标：
 * 1. 只定义 Agent 的主流程和职责边界，不写具体实现细节。
 * 2. 后续子类或具体实现类只需要把模型调用、工具执行、状态存储等能力补上即可。
 * 3. 让 loop/run/step 之间的关系清晰，方便继续拆分模块。
 *
 * 建议理解方式：
 * - loop(): 管整个 run 生命周期
 * - runStep(): 管单步状态推进
 * - 各种 build/parse/execute 方法：分别负责某一个阶段
 */

type AgentStopReason =
  | "finished"
  | "max_steps"
  | "cancelled"
  | "blocked"
  | "fatal_error";

type AgentRunState = {
  // 本次 run 的唯一标识，用于日志、trace、hook scope、存档等。
  runId: string;

  // 当前 run 是否仍然活跃。
  status: "idle" | "running" | "finished" | "failed" | "cancelled";

  // 当前已经执行到第几步。
  stepIndex: number;

  // 允许的最大步数，避免 while(true) 无限制循环。
  maxSteps: number;

  // 最终停止原因，只有在结束时才会有值。
  stopReason?: AgentStopReason;

  // 用户目标或当前任务描述。
  task?: string;

  // 历史消息。这里是抽象概念，不限定 message 结构。
  messages: unknown[];

  // 供整个 run 共享的上下文，例如 memory、摘要、工具缓存、策略信息等。
  shared: Record<string, unknown>;

  // 本次 run 的最终产出，例如 final answer、structured result、metrics 等。
  result?: unknown;

  // 记录最近一次错误，便于恢复、上报或调试。
  lastError?: unknown;
};

type AgentStepState = {
  // 当前 step 的序号，通常与 run.stepIndex 对齐。
  stepIndex: number;

  // 当前 step 的状态。
  status:
    | "preparing"
    | "calling_model"
    | "parsing_model_output"
    | "executing_tools"
    | "updating_state"
    | "finished";

  // 组装给模型的上下文内容。
  context?: Record<string, unknown>;

  // 发给模型的请求。
  modelRequest?: Record<string, unknown>;

  // 模型返回的原始结果。
  modelResponse?: Record<string, unknown>;

  // 解析后的结果，可能包含文本、tool calls、finish signal 等。
  parsedOutput?: {
    finalMessage?: unknown;
    toolCalls?: unknown[];
    shouldFinish?: boolean;
    finishReason?: string;
  };

  // 本轮工具执行后产出的 observation。
  observation?: Record<string, unknown>;

  // 本轮是否要求停止。
  shouldStop?: boolean;

  // 本轮要求停止的原因。
  stopReason?: AgentStopReason;

  // 本轮错误。
  error?: unknown;
};

class BaseAgent {
  /**
   * 可配置项。这里只保留最关键的运行参数。
   * 真正落地时，这里通常还会包括 model、tool registry、hook engine、memory、logger 等依赖。
   */
  protected config: {
    maxSteps: number;
  };

  /**
   * 当前运行态。
   * 一个 BaseAgent 实例可以只跑一次，也可以设计成支持多次 run；
   * 这里先按“当前只有一个活跃 run”来建模。
   */
  protected runState: AgentRunState | null = null;

  constructor(config?: Partial<{ maxSteps: number }>) {
    this.config = {
      maxSteps: config?.maxSteps ?? 20,
    };
  }

  /**
   * Agent 对外入口。
   *
   * 职责：
   * 1. 初始化 run 级状态
   * 2. 执行 beforeRun hook
   * 3. 按 step 循环推进任务
   * 4. 在结束前执行 beforeFinish hook
   * 5. 统一返回最终结果
   */
  async run(input?: { task?: string }) {
    // 1. 初始化本次 run 的状态
    const run = await this.initRun(input);
    this.runState = run;

    try {
      // 2. 进入正式运行前，先给外部留一个干预入口
      //    例如：
      //    - 注入 traceId
      //    - 做权限预检查
      //    - 动态改写 system prompt
      //    - 直接阻断本次任务
      await this.beforeRun(run);

      // 3. 主循环：每次循环推进一步
      while (this.shouldContinue(run)) {
        // 3.1 创建 step 级状态
        const step = this.createStepState(run);

        // 3.2 执行单步推进
        await this.runStep(run, step);

        // 3.3 将 step 结果合并回 run
        await this.commitStep(run, step);

        // 3.4 如果本轮已经决定停止，则提前跳出
        if (step.shouldStop) {
          run.stopReason = step.stopReason ?? "finished";
          break;
        }
      }

      // 4. 如果循环是因为达到上限退出，补上 stopReason
      if (!run.stopReason && run.stepIndex >= run.maxSteps) {
        run.stopReason = "max_steps";
      }

      // 5. 结束前的统一收尾
      await this.beforeFinish(run);

      // 6. 产出最终结果
      run.status = "finished";
      run.result = await this.buildFinalResult(run);
      return run.result;
    } catch (error) {
      // 7. run 级别异常处理
      run.status = "failed";
      run.stopReason = "fatal_error";
      run.lastError = error;

      // 真实实现里，这里通常还会：
      // - 上报 telemetry
      // - 写入错误日志
      // - 触发 onError hook
      // - 根据错误类型决定是否可恢复
      await this.handleRunError(run, error);

      throw error;
    } finally {
      // 8. finally 中做兜底清理
      //    例如：
      //    - 取消未完成的资源
      //    - 关闭流式输出
      //    - 落盘 run 记录
      await this.cleanupRun(run);
    }
  }

  /**
   * 单步推进。
   *
   * 职责：
   * 1. 组装上下文
   * 2. 调用模型
   * 3. 解析模型输出
   * 4. 如果有工具调用则执行工具
   * 5. 把结果写回 step 状态
   */
  protected async runStep(run: AgentRunState, step: AgentStepState) {
    try {
      // A. step 开始前的扩展点
      await this.beforeStep(run, step);

      // B. 构建上下文前的扩展点
      await this.beforeBuildContext(run, step);

      // C. 组装本轮上下文
      //    一般会包含：
      //    - system prompt
      //    - 历史消息
      //    - memory / summary
      //    - 可用工具清单
      //    - 当前任务目标
      //    - 上一轮的 observation
      step.context = await this.buildContext(run, step);

      // D. 把上下文转换成模型请求
      step.modelRequest = await this.buildModelRequest(run, step);

      // E. 模型调用前扩展点
      await this.beforeModelCall(run, step);

      // F. 调用模型
      step.status = "calling_model";
      step.modelResponse = await this.callModel(run, step);

      // G. 模型调用后扩展点
      await this.afterModelCall(run, step);

      // H. 解析模型输出
      //    这里要明确区分：
      //    - 最终答案
      //    - tool calls
      //    - 空响应 / 非法响应
      step.status = "parsing_model_output";
      step.parsedOutput = await this.parseModelOutput(run, step);

      // I. 如果模型已经给出最终答案，则本轮可以结束
      if (step.parsedOutput?.shouldFinish) {
        step.shouldStop = true;
        step.stopReason = "finished";
        step.status = "finished";
        return;
      }

      // J. 如果模型要求执行工具，则进入工具阶段
      if (step.parsedOutput?.toolCalls && step.parsedOutput.toolCalls.length > 0) {
        step.status = "executing_tools";

        // J1. 执行工具前，先做统一校验
        //     例如：
        //     - 工具是否存在
        //     - 参数是否合法
        //     - 是否需要权限确认
        //     - 当前策略是否允许调用
        await this.validateToolCalls(run, step);

        // J2. 执行一个或多个工具
        //     这里未来要决定：
        //     - 串行执行还是并行执行
        //     - 失败是否中断
        //     - 是否支持多 tool call 聚合
        step.observation = await this.executeToolCalls(run, step);

        // J3. 工具执行结果写回上下文
        //     下一轮模型调用时会把 observation 一起带上，
        //     让模型根据工具结果继续推理。
        await this.afterToolExecution(run, step);
      } else {
        // K. 没有 final message，也没有 tool calls
        //    这通常表示模型输出异常，需要兜底处理。
        //    后续可选策略：
        //    - 记一次错误并让模型重试
        //    - 直接结束
        //    - 注入系统纠错提示再继续
        await this.handleEmptyOrInvalidModelOutput(run, step);
      }

      // L. 本轮状态落地前的最后阶段
      step.status = "updating_state";
      await this.updateStepState(run, step);

      // M. 基于本轮结果判断是否继续
      //    常见判断条件：
      //    - hook / policy 阻断
      //    - 用户取消
      //    - 工具执行后出现致命错误
      //    - 已满足任务目标
      await this.decideStepContinuation(run, step);

      step.status = "finished";
    } catch (error) {
      // N. step 级别异常处理
      step.error = error;
      step.shouldStop = true;
      step.stopReason = "fatal_error";

      await this.handleStepError(run, step, error);

      throw error;
    }
  }

  /**
   * 初始化 run 状态。
   *
   * 这里不关注“怎么生成 runId”，只表达这个阶段必须存在。
   */
  protected async initRun(input?: { task?: string }): Promise<AgentRunState> {
    return {
      runId: "TODO_GENERATE_RUN_ID",
      status: "running",
      stepIndex: 0,
      maxSteps: this.config.maxSteps,
      task: input?.task,
      messages: [],
      shared: {},
    };
  }

  /**
   * run 级继续条件。
   *
   * 这里建议只保留纯判断逻辑，避免把副作用塞进来。
   */
  protected shouldContinue(run: AgentRunState): boolean {
    if (run.status !== "running") return false;
    if (run.stopReason) return false;
    if (run.stepIndex >= run.maxSteps) return false;
    return true;
  }

  /**
   * 创建 step 状态。
   */
  protected createStepState(run: AgentRunState): AgentStepState {
    return {
      stepIndex: run.stepIndex + 1,
      status: "preparing",
    };
  }

  /**
   * 将 step 结果提交到 run。
   *
   * 真实实现里通常会在这里：
   * - 追加 assistant message
   * - 追加 tool result message
   * - 更新 memory / summary
   * - 更新 metrics
   * - 推进 stepIndex
   */
  protected async commitStep(run: AgentRunState, step: AgentStepState) {
    run.stepIndex = step.stepIndex;

    if (step.error) {
      run.lastError = step.error;
    }

    if (step.shouldStop) {
      run.stopReason = step.stopReason;
    }
  }

  /**
   * beforeRun:
   * run 级入口 hook。
   */
  protected async beforeRun(_run: AgentRunState) {
    // 伪代码：
    // await hookEngine.execute("beforeRun", { run: _run, shared: _run.shared }, { scope: { kind: "run", runId: _run.runId } })
  }

  /**
   * beforeStep:
   * 每一步开始前执行，可用于打点、审计、预算检查。
   */
  protected async beforeStep(_run: AgentRunState, _step: AgentStepState) {
    // 伪代码：
    // await hookEngine.execute("beforeStep", { run: _run, step: _step, shared: _run.shared })
  }

  /**
   * beforeBuildContext:
   * 上下文构建前的插入点。
   */
  protected async beforeBuildContext(_run: AgentRunState, _step: AgentStepState) {
    // 伪代码：
    // await hookEngine.execute("beforeBuildContext", { run: _run, step: _step })
  }

  /**
   * 构建给模型使用的上下文。
   *
   * 注意：
   * 这里的“上下文”和“模型请求”最好分两层。
   * 前者是领域层抽象，后者是具体模型 SDK 所需格式。
   */
  protected async buildContext(
    run: AgentRunState,
    step: AgentStepState,
  ): Promise<Record<string, unknown>> {
    return {
      // 当前任务目标
      task: run.task,

      // 历史对话 / 历史事件
      messages: run.messages,

      // 共享状态，例如 memory、摘要、缓存
      shared: run.shared,

      // 当前 step 信息
      stepIndex: step.stepIndex,

      // 可用工具清单
      tools: "TODO_TOOL_SCHEMAS",
    };
  }

  /**
   * 构建模型请求。
   *
   * 例如把 buildContext 的结果转成：
   * - messages
   * - system
   * - tool definitions
   * - temperature
   * - max_tokens
   */
  protected async buildModelRequest(
    _run: AgentRunState,
    step: AgentStepState,
  ): Promise<Record<string, unknown>> {
    return {
      model: "TODO_MODEL",
      input: step.context,
    };
  }

  /**
   * beforeModelCall:
   * 模型调用前 hook。
   *
   * 很适合做：
   * - 请求改写
   * - 参数注入
   * - 安全检查
   * - tracing headers 注入
   */
  protected async beforeModelCall(_run: AgentRunState, _step: AgentStepState) {
    // 伪代码：
    // await hookEngine.execute("beforeModelCall", { run: _run, step: _step, modelRequest: _step.modelRequest })
  }

  /**
   * 调用模型。
   *
   * 这里只保留接口，不关心具体接哪家模型。
   */
  protected async callModel(
    _run: AgentRunState,
    _step: AgentStepState,
  ): Promise<Record<string, unknown>> {
    return {
      // 伪返回值结构
      type: "assistant_response",
      content: "TODO_MODEL_RESPONSE",
    };
  }

  /**
   * afterModelCall:
   * 模型返回后的 hook。
   */
  protected async afterModelCall(_run: AgentRunState, _step: AgentStepState) {
    // 伪代码：
    // await hookEngine.execute("afterModelCall", { run: _run, step: _step, modelRequest: _step.modelRequest, modelResponse: _step.modelResponse })
  }

  /**
   * 解析模型输出。
   *
   * 这是 Agent 的关键职责之一：
   * - 把底层模型返回转成统一结构
   * - 明确区分“结束”还是“继续调用工具”
   */
  protected async parseModelOutput(
    _run: AgentRunState,
    step: AgentStepState,
  ): Promise<NonNullable<AgentStepState["parsedOutput"]>> {
    return {
      // 这里是伪代码，真实逻辑要根据模型返回内容判断：
      // - 有没有 final answer
      // - 有没有 tool calls
      // - 有没有 finish reason
      finalMessage: undefined,
      toolCalls: Array.isArray(step.modelResponse?.["toolCalls"])
        ? (step.modelResponse?.["toolCalls"] as unknown[])
        : [],
      shouldFinish: false,
      finishReason: undefined,
    };
  }

  /**
   * 校验工具调用。
   *
   * 这里只做“能不能执行”的判断，不负责真正执行。
   */
  protected async validateToolCalls(_run: AgentRunState, _step: AgentStepState) {
    // 伪代码：
    // 1. 检查 tool name 是否已注册
    // 2. 校验 arguments 是否符合 schema
    // 3. 检查权限 / policy
    // 4. 必要时让 hook 参与 allow / deny / block 决策
    // 5. 对非法调用直接抛错或转换成 observation error
  }

  /**
   * 执行工具调用。
   *
   * 输出统一 observation，供下一轮模型继续使用。
   */
  protected async executeToolCalls(
    _run: AgentRunState,
    _step: AgentStepState,
  ): Promise<Record<string, unknown>> {
    // 伪代码：
    // for each toolCall:
    //   await beforeToolExecution hook
    //   执行 tool
    //   标准化 tool result / tool error
    //   await afterToolExecution hook
    // 聚合成 observation 返回
    return {
      toolResults: "TODO_TOOL_RESULTS",
    };
  }

  /**
   * 工具执行结束后的统一处理。
   *
   * 例如：
   * - 把 tool result 转为 message 追加进历史
   * - 更新 shared cache
   * - 压缩过长输出
   */
  protected async afterToolExecution(_run: AgentRunState, _step: AgentStepState) {
    // 伪代码：
    // await hookEngine.execute("afterToolExecution", { run: _run, step: _step, toolResult: _step.observation })
  }

  /**
   * 处理模型空输出或非法输出。
   */
  protected async handleEmptyOrInvalidModelOutput(_run: AgentRunState, _step: AgentStepState) {
    // 伪代码：
    // 选一种策略：
    // - 标记错误，允许下一轮带着纠错提示重试
    // - 直接 stop
    // - 构造成 observation 写回上下文
  }

  /**
   * 更新 step 状态。
   *
   * 这里主要负责“把当前 step 产生的信息真正写入 run 可持续状态”。
   */
  protected async updateStepState(run: AgentRunState, step: AgentStepState) {
    // 伪代码：
    // 1. 追加 assistant 输出到 run.messages
    // 2. 追加 tool observation 到 run.messages
    // 3. 更新 run.shared.memory / summary / metrics
    // 4. 对长上下文做裁剪

    if (step.parsedOutput?.finalMessage) {
      run.messages.push(step.parsedOutput.finalMessage);
    }

    if (step.observation) {
      run.messages.push(step.observation);
    }
  }

  /**
   * 决定本轮结束后是否继续。
   */
  protected async decideStepContinuation(run: AgentRunState, step: AgentStepState) {
    // 常见停止条件：
    // 1. step 已明确给出 shouldStop
    // 2. run 达到最大步数
    // 3. hook / policy 阻断
    // 4. 用户取消
    // 5. 预算耗尽

    if (step.shouldStop) return;

    if (step.stepIndex >= run.maxSteps) {
      step.shouldStop = true;
      step.stopReason = "max_steps";
    }
  }

  /**
   * beforeFinish:
   * run 结束前的最后一个统一扩展点。
   */
  protected async beforeFinish(_run: AgentRunState) {
    // 伪代码：
    // await hookEngine.execute("beforeFinish", { run: _run, shared: _run.shared, observation: { stopReason: _run.stopReason } })
  }

  /**
   * 构造最终返回值。
   */
  protected async buildFinalResult(run: AgentRunState) {
    return {
      runId: run.runId,
      stopReason: run.stopReason,
      stepCount: run.stepIndex,
      messages: run.messages,
      shared: run.shared,
    };
  }

  /**
   * run 级错误处理。
   */
  protected async handleRunError(_run: AgentRunState, _error: unknown) {
    // 伪代码：
    // - 记录日志
    // - 通知监控系统
    // - 触发错误 hook
  }

  /**
   * step 级错误处理。
   */
  protected async handleStepError(
    _run: AgentRunState,
    _step: AgentStepState,
    _error: unknown,
  ) {
    // 伪代码：
    // - 记录当前 step 的失败信息
    // - 判断是否允许重试
    // - 决定错误是否转成 observation 回喂给模型
  }

  /**
   * run 结束后的资源清理。
   */
  protected async cleanupRun(_run: AgentRunState) {
    // 伪代码：
    // - 释放资源
    // - 停止事件订阅
    // - 关闭流
    // - 落盘 trace / transcript
  }
}

export { BaseAgent };
