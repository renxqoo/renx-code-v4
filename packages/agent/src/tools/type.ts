import type { ZodType } from "zod";

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

/**
 * An agent-callable tool definition.
 *
 * @typeParam TArgs - The typed shape of arguments this tool accepts. Defaults to `Record<string, unknown>`.
 */
export type AgentTool<TArgs extends Record<string, unknown> = Record<string, unknown>> = {
  /**
   * Stable machine identifier for the tool (e.g. `"fs_read_file"`).
   * Used for tool lookup, deduplication, and routing — not sent to the LLM.
   */
  id: string;
  /**
   * Human / LLM-facing name (e.g. `"Read File"`).
   * This is the name sent to the model in the tool definition; it should be
   * descriptive enough for the LLM to select the right tool.
   */
  name: string;
  /** 发给模型的工具说明；缺省为 `name`。 */
  description?: string;
  type: "read_only" | "write_only" | "read_write";
  execute: (args: TArgs) => Promise<AgentToolExecutionResult>;
  /** Zod schema used to validate and parse tool arguments before execution. */
  schema: ZodType<TArgs>;
  /**
   * 覆盖 `SandboxRegistry` 解析用的 profile（见 `ctx.shared.sandboxProfile`）。
   * 未设置时沿用中间件写入的默认 profile。
   */
  sandboxProfileId?: string;
  /**
   * Maximum execution time in milliseconds. If the tool execution exceeds this
   * duration, it will be terminated and a failure result returned.
   * `undefined` or `0` means no timeout.
   */
  timeoutMs?: number;
};

export type AgentToolExecutionResult = {
  success: boolean;
  content: string;
  metadata: Record<string, unknown>;
};
