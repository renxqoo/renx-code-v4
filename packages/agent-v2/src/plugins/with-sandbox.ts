import type { Plugin } from "../plugin.js";
import type { AgentInput, AgentGenerator } from "../types.js";
import type { Tool, ToolContext } from "../tool.js";

/**
 * Minimal sandbox executor contract.
 *
 * Structurally compatible with {@link SandboxBackend} from `@renx/agent`,
 * so existing backends (CubeSandboxBackend, DockerSandboxBackend, etc.)
 * can be passed directly without an adapter layer.
 */
export type SandboxExecutor = {
  readonly id: string;
  execute(req: {
    tool: { name: string; id?: string };
    args: Record<string, unknown>;
    callId: string;
  }): Promise<SandboxResult>;
};

export type SandboxResult = {
  success: boolean;
  content: string;
  metadata: Record<string, unknown>;
};

/**
 * Wraps an agent-v2 Tool so every invocation is routed through a sandbox.
 *
 * The sandbox receives the tool name, parsed arguments, and a callId.
 * On success the `content` string becomes the tool's return value.
 * On failure an Error is thrown (caught by the agent core loop).
 */
export function wrapTool<I = unknown, O = unknown>(
  tool: Tool<I, O>,
  sandbox: SandboxExecutor,
): Tool<I, O> {
  return {
    ...tool,
    execute: async (input: I, ctx: ToolContext): Promise<O> => {
      const args = (input as unknown) as Record<string, unknown>;
      const result = await sandbox.execute({
        tool: { name: tool.name },
        args,
        callId: ctx.runId,
      });

      if (!result.success) {
        throw new Error(result.content);
      }

      return result.content as unknown as O;
    },
  };
}

/**
 * Plugin: rewrites `input.tools` so matching tools run in a sandbox.
 *
 * ## Usage
 *
 * ```ts
 * import { pipe, agent }    from "@renx/agent-v2";
 * import { withSandbox }    from "@renx/agent-v2/plugins";
 * import { CubeSandboxBackend } from "@renx/agent";
 *
 * const sandbox = new CubeSandboxBackend({ apiKey: "…" });
 *
 * const run = pipe(
 *   withSandbox({ sandbox, tools: ["run_code"] }),
 *   agent,
 * );
 * ```
 *
 * @param opts.sandbox - Sandbox executor (CubeSandboxBackend, etc.)
 * @param opts.tools   - `"*"` for all tools, or an explicit name list.
 *                       Defaults to `"*"`.
 *
 * **Morphology:** Input Injector — rewrites `input.tools` before delegation.
 */
export function withSandbox(opts: {
  sandbox: SandboxExecutor;
  tools?: "*" | string[];
}): Plugin {
  const filter = opts.tools ?? "*";

  return (inner) =>
    async function* (input: AgentInput): AgentGenerator {
      if (!input.tools || input.tools.length === 0) {
        return yield* inner(input);
      }

      const wrappedTools = input.tools.map((tool) => {
        if (filter === "*" || filter.includes(tool.name)) {
          return wrapTool(tool, opts.sandbox);
        }
        return tool;
      });

      yield* inner({ ...input, tools: wrappedTools });
    };
}
