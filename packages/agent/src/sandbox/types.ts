import type { AgentTool, AgentToolExecutionResult } from "../tools/type";

/**
 * 一次工具调用在沙箱里的执行上下文（由中间件 / 编排层注入）。
 * 不同环境（K8s、Docker、本地）可扩展 `policy` 字段。
 */
export type SandboxExecutionContext = {
  /** 与 `SandboxRegistry` 中注册的 profile 对应，如 `in_process`、`docker_default`。 */
  profileId: string;
  traceId?: string;
  tenantId?: string;
  /** 策略扩展：超时秒数、网络、allowedPaths 等，由各 SandboxBackend 自行解释。 */
  policy?: Record<string, unknown>;
};

/**
 * 交给具体 SandboxBackend 的一次执行请求。
 */
export type SandboxExecutionRequest = {
  tool: AgentTool;
  args: Record<string, unknown>;
  callId: string;
  context: SandboxExecutionContext;
};

/**
 * 沙箱后端：一种隔离/执行环境（进程内、子进程、容器、远程 Worker）。
 * 新增环境时实现此接口并在 `SandboxRegistry` 注册即可，无需改 Agent 核心循环。
 */
export interface SandboxBackend {
  /** 稳定标识，用于日志与排错。 */
  readonly id: string;
  execute(req: SandboxExecutionRequest): Promise<AgentToolExecutionResult>;
  /** 可选：进程退出前释放。 */
  dispose?(): Promise<void>;
}
