/** Koa 风格 `next()`，调用则进入下一层中间件。 */
export type Next = () => Promise<void>;

export type HookPatchBucket = Record<string, unknown>;

export type HookControlPatch = {
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  /**
   * `beforeToolExecution`：`deny` / `block` 时跳过真实工具调用，向模型注入失败型 tool 结果（见循环内处理）。
   * 需要整轮中止请用 `continue: false`，勿与 `deny` 混用。
   */
  decision?: "allow" | "deny" | "approve" | "block";
  tags?: string[];
};

/** `queryModel` 循环中各阶段事件名（与中间件 `ctx.event` 一致）。 */
export const AGENT_EVENTS = [
  "beforeRun",
  "beforeStep",
  "beforeBuildContext",
  "beforeModelCall",
  "afterModelCall",
  "beforeToolExecution",
  "afterToolExecution",
  "beforeFinish",
] as const;

export type AgentEventName = (typeof AGENT_EVENTS)[number];

/**
 * 跨阶段携带的状态（不含 `event` / `signal` / `scope`）。
 */
export type MiddlewareCarry = {
  run?: unknown;
  step?: unknown;
  metadata?: HookPatchBucket;
  shared?: HookPatchBucket;
  eventData?: HookPatchBucket;
  context?: HookPatchBucket;
  modelRequest?: HookPatchBucket;
  modelResponse?: HookPatchBucket;
  toolInvocation?: HookPatchBucket;
  toolResult?: HookPatchBucket;
  observation?: HookPatchBucket;
  permissions?: HookPatchBucket;
  control?: HookControlPatch;
  error?: unknown;
};

/**
 * 单次中间件调用的完整上下文；通过 `ctx.event` 判断当前阶段并读写各 bucket。
 */
export type AgentMiddlewareContext = MiddlewareCarry & {
  event: AgentEventName;
  signal?: AbortSignal;
  scope?: { kind: "global" } | { kind: "session"; sessionId: string } | { kind: "run"; runId: string };
};

/**
 * 类型化的中间件 carry：每个 bucket 使用 `Record<string, unknown>` 作为安全默认值，
 * 中间件开发者可按事件阶段自行窄化。
 *
 * 与 `MiddlewareCarry`（全部 `Record<string, unknown>`）向后兼容。
 */
export type TypedMiddlewareCarry = MiddlewareCarry;

/**
 * 类型化的中间件上下文：`event` 为具体事件名 `E`，
 * 便于中间件按阶段窄化 `eventData` / `context` 等 bucket 的结构。
 */
export type TypedAgentMiddlewareContext<E extends AgentEventName = AgentEventName> =
  Omit<AgentMiddlewareContext, "event"> & { event: E };

/**
 * 类型化的中间件函数：泛型 `E` 对应 `AgentEventName`，默认全阶段。
 */
export type TypedAgentMiddleware<E extends AgentEventName = AgentEventName> = (
  ctx: TypedAgentMiddlewareContext<E>,
  next: Next,
) => void | Promise<void>;

export type AgentMiddleware = (ctx: AgentMiddlewareContext, next: Next) => void | Promise<void>;

/**
 * Koa 风格串联中间件（与 `koa-compose` 行为一致）。
 */
export function compose(middleware: AgentMiddleware[]): (
  ctx: AgentMiddlewareContext,
  next?: Next,
) => Promise<void> {
  if (!Array.isArray(middleware)) {
    throw new TypeError("Middleware stack must be an array");
  }
  for (const fn of middleware) {
    if (typeof fn !== "function") {
      throw new TypeError("Middleware must be composed of functions");
    }
  }

  return function (context: AgentMiddlewareContext, next?: Next): Promise<void> {
    let index = -1;

    function dispatch(i: number): Promise<void> {
      if (i <= index) {
        return Promise.reject(new Error("next() called multiple times"));
      }
      index = i;
      let fn = middleware[i];
      if (i === middleware.length) {
        fn = next as AgentMiddleware;
      }
      if (!fn) {
        return Promise.resolve();
      }
      return Promise.resolve(fn(context, dispatch.bind(null, i + 1)));
    }

    return dispatch(0);
  };
}

export function mergeCarry(input: MiddlewareCarry, ctx: AgentMiddlewareContext): MiddlewareCarry {
  return {
    ...input,
    shared: ctx.shared,
    metadata: ctx.metadata,
    eventData: ctx.eventData,
    context: ctx.context,
    modelRequest: ctx.modelRequest,
    modelResponse: ctx.modelResponse,
    toolInvocation: ctx.toolInvocation,
    toolResult: ctx.toolResult,
    observation: ctx.observation,
    permissions: ctx.permissions,
    control: ctx.control,
    error: ctx.error,
    run: ctx.run,
    step: ctx.step,
  };
}
