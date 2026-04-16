import type { Message } from "../../domain/message";
import type { AgentMiddleware, AgentMiddlewareContext } from "../middleware";

export type StoreMessagesMeta = {
  event: string;
  /** `beforeModelCall` / `beforeBuildContext` 等阶段里由循环注入 */
  llmRound?: number;
  /** `beforeFinish` 时：`success` | `error` | `max_steps` */
  finishReason?: string;
};

export type StoreMessagesPayload = {
  messages: Message[];
  meta: StoreMessagesMeta;
};

export type StoreMessagesOptions = {
  /**
   * 持久化回调；建议自行 `clone`/`JSON` 若会异步改写原数组。
   * 出错时默认仅 `console.error`，可用 `onSaveError` 覆盖。
   */
  save: (payload: StoreMessagesPayload) => void | Promise<void>;
  /**
   * - `before_each_llm`：每次 `beforeModelCall` 落盘（含多轮工具循环中的每一轮请求前，消息已含上轮 tool 结果）。
   * - `on_finish`：仅在 `beforeFinish` 落盘（正常结束、错误、超步数）。
   * - `both`：以上二者（结束可能与上一轮 beforeModelCall 内容重复，便于「最终态」单独归档）。
   */
  mode?: "before_each_llm" | "on_finish" | "both";
  onSaveError?: (error: unknown) => void;
};

function messagesFromContext(ctx: AgentMiddlewareContext): Message[] | undefined {
  const c = ctx.context as { messages?: Message[] } | undefined;
  return c?.messages;
}

function roundFromContext(ctx: AgentMiddlewareContext): number | undefined {
  const c = ctx.context as { llmRounds?: number } | undefined;
  if (typeof c?.llmRounds === "number") return c.llmRounds;
  const s = ctx.step as { llmRounds?: number } | undefined;
  return typeof s?.llmRounds === "number" ? s.llmRounds : undefined;
}

function finishReasonFromEventData(ctx: AgentMiddlewareContext): string | undefined {
  const ed = ctx.eventData as { reason?: unknown } | undefined;
  return typeof ed?.reason === "string" ? ed.reason : undefined;
}

/**
 * 将当前对话 `messages` 快照交给 `save` 持久化。
 *
 * **流式 token**：不走本中间件；请使用 `queryModel` 第二参里的 `onStreamChunk(chunk, meta)`，
 * 或用 `createStreamRecorder()` 收集后再落库（见 `stream-recorder.ts`）。
 *
 * **建议**：`agent.use(createStoreMessagesMiddleware(...), ...其它中间件)` 把本中间件写在**最前**（洋葱最外层），
 * 以便 `await next()` 之后同阶段的其它中间件已更新过 `ctx.context`。
 */
export function createStoreMessagesMiddleware(options: StoreMessagesOptions): AgentMiddleware {
  const mode = options.mode ?? "both";
  const onErr =
    options.onSaveError ??
    ((e: unknown) => {
      console.error("[store-messages] save failed:", e);
    });

  const saveBeforeLlm = mode === "before_each_llm" || mode === "both";
  const saveOnFinish = mode === "on_finish" || mode === "both";

  return async (ctx, next) => {
    await next();

    try {
      if (ctx.event === "beforeModelCall" && saveBeforeLlm) {
        const messages = messagesFromContext(ctx);
        if (messages?.length !== undefined) {
          await options.save({
            messages,
            meta: {
              event: ctx.event,
              llmRound: roundFromContext(ctx),
            },
          });
        }
        return;
      }

      if (ctx.event === "beforeFinish" && saveOnFinish) {
        const messages = messagesFromContext(ctx);
        if (messages?.length !== undefined) {
          await options.save({
            messages,
            meta: {
              event: ctx.event,
              finishReason: finishReasonFromEventData(ctx),
            },
          });
        }
      }
    } catch (e) {
      onErr(e);
    }
  };
}
