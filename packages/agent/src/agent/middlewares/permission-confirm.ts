import type { AgentMiddleware, AgentMiddlewareContext } from "../middleware";

/** `beforeToolExecution` 里单条待执行工具调用（与循环注入结构一致）。 */
export type PermissionToolInvocation = {
  callId: string;
  name: string;
  args: Record<string, unknown>;
};

export type PermissionConfirmRequest = {
  /** 本轮中判定为需要审批的调用（可能多条）。 */
  invocations: PermissionToolInvocation[];
};

export type PermissionConfirmOptions = {
  /**
   * 按工具名匹配：列在此处的工具需要走 `confirm`。
   * 若与 `requiresConfirm` 都未配置，则不会对任何工具做确认（安全默认）。
   */
  toolsRequiringConfirm?: string[];
  /**
   * 细粒度判断；与 `toolsRequiringConfirm` 同时存在时，**满足任一**即视为需要确认。
   */
  requiresConfirm?: (name: string, args: Record<string, unknown>) => boolean;
  /**
   * 审批通过返回 `true`；返回 `false` 时行为由 `onReject` 决定。
   */
  confirm: (req: PermissionConfirmRequest) => Promise<boolean>;
  /**
   * 用户拒绝时：
   * - `inject_denial`（默认）：`decision: deny`，注入失败型 tool 结果，对话继续；
   * - `abort`：`continue: false`，立即结束 `queryModel`（`stopped: true`），不再执行工具与后续轮次。
   *   注意：此时 assistant 侧可能已带有 tool_calls 而无 tool 结果，若需持久化对话请自行处理。
   */
  onReject?: "inject_denial" | "abort";
  /** 拒绝时写入 `control.stopReason`（`inject_denial` 时亦出现在注入给模型的失败文案中）。 */
  denyReason?: string;
};

function parseInvocations(ctx: AgentMiddlewareContext): PermissionToolInvocation[] {
  const raw = ctx.toolInvocation as { invocations?: unknown } | undefined;
  const list = raw?.invocations;
  if (!Array.isArray(list)) return [];
  const out: PermissionToolInvocation[] = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const callId = r.callId;
    const name = r.name;
    const args = r.args;
    if (typeof callId !== "string" || typeof name !== "string") continue;
    out.push({
      callId,
      name,
      args: args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
    });
  }
  return out;
}

function needsConfirm(
  inv: PermissionToolInvocation,
  options: PermissionConfirmOptions,
): boolean {
  const byList =
    options.toolsRequiringConfirm != null && options.toolsRequiringConfirm.includes(inv.name);
  const byFn = options.requiresConfirm?.(inv.name, inv.args) === true;
  return byList || byFn;
}

/**
 * 在 `beforeToolExecution` 中对敏感工具做权限确认。
 *
 * 注意：若本轮同时存在「需确认」与「不需确认」的工具，用户拒绝时当前实现会 **拒绝整批** 调用。
 */
export function createPermissionConfirmMiddleware(
  options: PermissionConfirmOptions,
): AgentMiddleware {
  const denyReason = options.denyReason ?? "User did not confirm this tool execution.";
  const onReject = options.onReject ?? "inject_denial";

  return async (ctx, next) => {
    if (ctx.event !== "beforeToolExecution") {
      await next();
      return;
    }

    const all = parseInvocations(ctx);
    if (all.length === 0) {
      await next();
      return;
    }

    const flagged = all.filter((inv) => needsConfirm(inv, options));
    if (flagged.length === 0) {
      await next();
      return;
    }

    const ok = await options.confirm({ invocations: flagged });
    if (!ok) {
      if (onReject === "abort") {
        ctx.control = { continue: false, stopReason: denyReason };
      } else {
        ctx.control = { decision: "deny", stopReason: denyReason };
      }
    }
    await next();
  };
}
