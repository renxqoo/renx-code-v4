import type { AgentTool } from "../tools/type";
import type { MiddlewareCarry } from "../agent/middleware";
import type { SandboxExecutionContext } from "./types";

/**
 * 从中间件 carry + 单工具元数据拼出本次执行的沙箱上下文。
 * - `ctx.shared.sandboxProfile`：默认 profile（字符串）
 * - `ctx.shared.sandboxPolicy`：各后端自定义策略
 * - `ctx.metadata.traceId` / `tenantId`：可选
 * - `tool.sandboxProfileId`：按工具覆盖 profile
 */
export function buildSandboxExecutionContext(
  carry: MiddlewareCarry,
  tool: AgentTool,
): SandboxExecutionContext {
  const shared = carry.shared as
    | { sandboxProfile?: unknown; sandboxPolicy?: Record<string, unknown> }
    | undefined;
  const profileFromShared =
    typeof shared?.sandboxProfile === "string" ? shared.sandboxProfile : undefined;
  const profileId = tool.sandboxProfileId ?? profileFromShared ?? "in_process";

  const meta = carry.metadata as { traceId?: string; tenantId?: string } | undefined;

  return {
    profileId,
    traceId: meta?.traceId,
    tenantId: meta?.tenantId,
    policy: shared?.sandboxPolicy,
  };
}
