import type { SandboxBackend, SandboxExecutionRequest } from "../types";
import type { AgentToolExecutionResult } from "../../tools/type";
import { toolResultError } from "../../tools/util";
import { Sandbox } from "@e2b/code-interpreter";

export type CubeSandboxBackendOptions = {
  /** CubeSandbox API endpoint (default `http://127.0.0.1:3000`). */
  apiUrl?: string;
  /** API key for CubeSandbox (default `"dummy"`). */
  apiKey?: string;
  /** Sandbox template ID. If omitted, uses the sandbox provider's default template. */
  templateId?: string;
  /** Backend identifier (default `"cube_sandbox"`). */
  id?: string;
  /** Default execution timeout in milliseconds. */
  timeoutMs?: number;
};

export class CubeSandboxBackend implements SandboxBackend {
  readonly id: string;
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly templateId: string | undefined;

  /** Lazily-created sandbox reused across execute() calls within one session. */
  private sandboxInstance: Sandbox | null = null;
  private sandboxPromise: Promise<Sandbox> | null = null;

  constructor(options: CubeSandboxBackendOptions) {
    this.id = options.id ?? "cube_sandbox";
    this.apiUrl = options.apiUrl ?? "http://127.0.0.1:3000";
    this.apiKey = options.apiKey ?? "dummy";
    this.templateId = options.templateId;
  }

  async execute(req: SandboxExecutionRequest): Promise<AgentToolExecutionResult> {
    const { tool, args, callId } = req;
    const code = typeof args.code === "string" ? args.code : JSON.stringify(args);

    try {
      const sandbox = await this.getOrCreateSandbox();
      const execution = await sandbox.runCode(code);

      if (execution.error) {
        const errInfo = execution.error.name
          ? `${execution.error.name}: ${execution.error.value ?? ""}`
          : String(execution.error);
        return {
          success: false,
          content: `CubeSandbox execution error: ${errInfo}`,
          metadata: {
            name: tool.name,
            id: callId,
            args,
            error: execution.error,
            logs: execution.logs,
          },
        };
      }

      const lines: string[] = [];
      for (const line of execution.logs?.stdout ?? []) {
        lines.push(line);
      }
      for (const result of execution.results ?? []) {
        if (result.text) {
          lines.push(result.text);
        }
      }
      const content = lines.length > 0 ? lines.join("\n") : (execution.text ?? "");

      return {
        success: true,
        content,
        metadata: {
          name: tool.name,
          id: callId,
          args,
          results: execution.results,
          logs: execution.logs,
        },
      };
    } catch (error) {
      // Sandbox may have died — clear so the next call creates a fresh one
      this.sandboxInstance = null;
      this.sandboxPromise = null;
      return toolResultError(tool.name, callId, args, error as Error);
    }
  }

  private getOrCreateSandbox(): Promise<Sandbox> {
    if (this.sandboxInstance) {
      return Promise.resolve(this.sandboxInstance);
    }
    if (!this.sandboxPromise) {
      this.sandboxPromise = Sandbox.create({
        apiKey: this.apiKey,
        apiUrl: this.apiUrl,
        ...(this.templateId ? { template: this.templateId } : {}),
      }).then((s: Sandbox) => {
        this.sandboxInstance = s;
        return s;
      });
    }
    return this.sandboxPromise!;
  }

  async dispose(): Promise<void> {
    if (this.sandboxInstance) {
      await this.sandboxInstance.kill().catch(() => {});
      this.sandboxInstance = null;
      this.sandboxPromise = null;
    }
  }
}
