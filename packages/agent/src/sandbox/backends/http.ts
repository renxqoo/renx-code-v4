import type { AgentTool, AgentToolExecutionResult } from "../../tools/type";
import { toolResultError } from "../../tools/util";
import type { SandboxBackend, SandboxExecutionRequest } from "../types";

export type HttpSandboxToolDescriptor = Pick<
  AgentTool,
  "id" | "name" | "description" | "type" | "timeoutMs"
>;

export type HttpSandboxExecutePayload = {
  callId: string;
  args: Record<string, unknown>;
  context: SandboxExecutionRequest["context"];
  tool: HttpSandboxToolDescriptor;
};

export type HttpSandboxBackendOptions = {
  endpoint: string | URL;
  id?: string;
  fetch?: typeof fetch;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  timeoutMs?: number;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (Object.prototype.toString.call(value) !== "[object Object]") {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function toSerializableTool(tool: AgentTool): HttpSandboxToolDescriptor {
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
    throw new Error("Remote sandbox response must be an object.");
  }
  const success = value.success;
  const content = value.content;
  const metadata = value.metadata;
  if (typeof success !== "boolean") {
    throw new Error("Remote sandbox response must include a boolean success field.");
  }
  if (typeof content !== "string") {
    throw new Error("Remote sandbox response must include a string content field.");
  }
  return {
    success,
    content,
    metadata: isPlainObject(metadata) ? metadata : {},
  };
}

async function resolveHeaders(
  headers: HttpSandboxBackendOptions["headers"],
): Promise<HeadersInit | undefined> {
  if (typeof headers === "function") {
    return headers();
  }
  return headers;
}

export class HttpSandboxBackend implements SandboxBackend {
  readonly id: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly headers?: HttpSandboxBackendOptions["headers"];
  private readonly defaultTimeoutMs: number;

  constructor(options: HttpSandboxBackendOptions) {
    this.id = options.id ?? "remote_http";
    this.endpoint = String(options.endpoint);
    this.fetchImpl = options.fetch ?? fetch;
    this.headers = options.headers;
    this.defaultTimeoutMs = Math.max(0, options.timeoutMs ?? 0);
  }

  async execute(req: SandboxExecutionRequest): Promise<AgentToolExecutionResult> {
    const controller = new AbortController();
    const timeoutMs = req.tool.timeoutMs ?? this.defaultTimeoutMs;
    const timeout =
      timeoutMs > 0
        ? setTimeout(() => {
            controller.abort();
          }, timeoutMs)
        : undefined;
    try {
      const customHeaders = await resolveHeaders(this.headers);
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(customHeaders ?? {}),
        },
        body: JSON.stringify({
          callId: req.callId,
          args: req.args,
          context: req.context,
          tool: toSerializableTool(req.tool),
        } satisfies HttpSandboxExecutePayload),
        signal: controller.signal,
      });

      const rawText = await response.text();
      if (!response.ok) {
        throw new Error(`Remote sandbox responded with HTTP ${response.status}: ${rawText}`);
      }

      const payload = rawText.length > 0 ? JSON.parse(rawText) : {};
      return normalizeResult(payload);
    } catch (error) {
      return toolResultError(req.tool.name, req.callId, req.args, error as Error);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }
}
