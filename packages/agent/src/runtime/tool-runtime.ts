import type { ResolvedRunProfile } from "../agent/hooks";
import type { AgentLogger } from "../agent/logger";
import { buildSandboxExecutionContext } from "../sandbox/context";
import type { SandboxRegistry } from "../sandbox/sandbox-registry";
import { parseToolCallArguments } from "../tools/parse-args";
import type { ToolRegistry } from "../tools/registry";
import { toolExecutor } from "../tools/tool-executor";
import type { AgentToolExecutionResult } from "../tools/type";
import type { CanonicalToolCall } from "@renx/provider";

export type PreparedToolInvocation = {
  tool: NonNullable<ReturnType<ToolRegistry["get"]>>;
  args: Record<string, unknown>;
  callId: string;
};

export class ToolRuntime {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly sandboxRegistry: SandboxRegistry,
    private readonly logger: AgentLogger,
  ) {}

  prepare(calls: CanonicalToolCall[]): PreparedToolInvocation[] {
    return calls.map((call) => {
      const tool = this.registry.get(call.name);
      if (!tool) {
        throw new Error(`Tool not registered: ${call.name}`);
      }
      const parsed = parseToolCallArguments(call.arguments);
      if (!parsed.ok) {
        this.logger.warn("parseToolCallArguments failed", {
          toolName: call.name,
          callId: call.id,
          parseError: parsed.parseError,
        });
      }
      return {
        tool,
        args: parsed.args,
        callId: call.id,
      };
    });
  }

  async execute(
    invocations: PreparedToolInvocation[],
    profile: ResolvedRunProfile,
  ): Promise<AgentToolExecutionResult[]> {
    return toolExecutor(invocations, {
      sandboxRegistry: this.sandboxRegistry,
      getSandboxContext: (tool) => buildSandboxExecutionContext(profile, tool),
    });
  }

  deny(callId: string, toolName: string, reason: string): AgentToolExecutionResult {
    return {
      success: false,
      content: reason,
      metadata: { denied: true, callId, toolName },
    };
  }
}
