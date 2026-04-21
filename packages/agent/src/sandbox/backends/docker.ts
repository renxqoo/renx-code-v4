import { spawn } from "node:child_process";
import type { AgentTool, AgentToolExecutionResult } from "../../tools/type";
import { toolResultError } from "../../tools/util";
import type { SandboxBackend, SandboxExecutionRequest } from "../types";

export type DockerSandboxToolDescriptor = Pick<
  AgentTool,
  "id" | "name" | "description" | "type" | "timeoutMs"
>;

export type DockerSandboxExecutePayload = {
  callId: string;
  args: Record<string, unknown>;
  context: SandboxExecutionRequest["context"];
  tool: DockerSandboxToolDescriptor;
};

export type DockerCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export type DockerCommandRunner = (input: {
  command: string;
  args: string[];
  stdin: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}) => Promise<DockerCommandResult>;

export type DockerSandboxBackendOptions = {
  image: string;
  id?: string;
  dockerCommand?: string;
  containerCommand?: string[];
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  runner?: DockerCommandRunner;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (Object.prototype.toString.call(value) !== "[object Object]") {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function toSerializableTool(tool: AgentTool): DockerSandboxToolDescriptor {
  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    type: tool.type,
    timeoutMs: tool.timeoutMs,
  };
}

function normalizeResult(value: unknown): AgentToolExecutionResult {
  if (!isPlainObject(value)) {
    throw new Error("Docker sandbox response must be an object.");
  }
  if (typeof value.success !== "boolean") {
    throw new Error("Docker sandbox response must include a boolean success field.");
  }
  if (typeof value.content !== "string") {
    throw new Error("Docker sandbox response must include a string content field.");
  }
  return {
    success: value.success,
    content: value.content,
    metadata: isPlainObject(value.metadata) ? value.metadata : {},
  };
}

async function defaultRunner(input: {
  command: string;
  args: string[];
  stdin: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<DockerCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout =
      input.timeoutMs && input.timeoutMs > 0
        ? setTimeout(() => {
            child.kill("SIGKILL");
            if (!settled) {
              settled = true;
              reject(new Error(`Docker sandbox timed out after ${input.timeoutMs}ms`));
            }
          }, input.timeoutMs)
        : undefined;

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (exitCode) => {
      if (timeout) clearTimeout(timeout);
      if (!settled) {
        settled = true;
        resolve({ stdout, stderr, exitCode });
      }
    });

    child.stdin.write(input.stdin);
    child.stdin.end();
  });
}

export class DockerSandboxBackend implements SandboxBackend {
  readonly id: string;
  private readonly image: string;
  private readonly dockerCommand: string;
  private readonly containerCommand: string[];
  private readonly extraArgs: string[];
  private readonly env?: NodeJS.ProcessEnv;
  private readonly defaultTimeoutMs: number;
  private readonly runner: DockerCommandRunner;

  constructor(options: DockerSandboxBackendOptions) {
    this.id = options.id ?? "docker";
    this.image = options.image;
    this.dockerCommand = options.dockerCommand ?? "docker";
    this.containerCommand = options.containerCommand ?? [];
    this.extraArgs = options.extraArgs ?? [];
    this.env = options.env;
    this.defaultTimeoutMs = Math.max(0, options.timeoutMs ?? 0);
    this.runner = options.runner ?? defaultRunner;
  }

  async execute(req: SandboxExecutionRequest): Promise<AgentToolExecutionResult> {
    const payload: DockerSandboxExecutePayload = {
      callId: req.callId,
      args: req.args,
      context: req.context,
      tool: toSerializableTool(req.tool),
    };

    const dockerArgs = [
      "run",
      "--rm",
      "-i",
      ...(req.context.policy?.network === false ? ["--network", "none"] : []),
      ...this.extraArgs,
      this.image,
      ...this.containerCommand,
    ];

    try {
      const result = await this.runner({
        command: this.dockerCommand,
        args: dockerArgs,
        stdin: JSON.stringify(payload),
        env: this.env,
        timeoutMs: req.tool.timeoutMs ?? this.defaultTimeoutMs,
      });
      if (result.exitCode !== 0) {
        throw new Error(`Docker sandbox exited with code ${result.exitCode}: ${result.stderr.trim()}`);
      }
      return normalizeResult(JSON.parse(result.stdout));
    } catch (error) {
      return toolResultError(req.tool.name, req.callId, req.args, error as Error);
    }
  }
}
