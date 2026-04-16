import type { SandboxBackend, SandboxExecutionRequest } from "../types";
import type { AgentToolExecutionResult } from "../../tools/type";
import { toolResultError, validateTool } from "../../tools/util";

/**
 * 默认：与当前 `toolExecutor` 进程内执行一致，无额外隔离。
 * 生产环境可并列注册 `DockerSandboxBackend`、`RemoteSandboxBackend` 等。
 */
export class InProcessSandboxBackend implements SandboxBackend {
  readonly id = "in_process";

  async execute(req: SandboxExecutionRequest): Promise<AgentToolExecutionResult> {
    const { tool, args, callId } = req;
    try {
      const toolArgs = validateTool({ toolCall: tool, args });
      return await tool.execute(toolArgs);
    } catch (error) {
      return toolResultError(tool.name, callId, args, error as Error);
    }
  }
}
