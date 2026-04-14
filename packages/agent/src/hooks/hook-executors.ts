import { spawn } from "node:child_process";

import {
  HookCommandExitError,
  HookHttpError,
  HookSerializationError,
  HookTimeoutError,
} from "./hook-errors";
import { HookEventBus } from "./hook-events";
import { parseHookProtocolOutput } from "./hook-protocol";
import type {
  CallbackHookDefinition,
  CommandHookDefinition,
  HookContext,
  HookDefinition,
  HookExecutionIssue,
  HookInvocationResult,
  HookPatch,
  HttpHookDefinition,
} from "./hook-types";

type ExecutorOptions<E extends string> = {
  bus: HookEventBus;
  signal?: AbortSignal;
  timeoutMs?: number;
};

type ExecutionClock = {
  startedAt: string;
  startedAtMs: number;
};

type ExecutorSuccess<E extends string> = HookInvocationResult<E> & {
  status: "success" | "blocked";
  patch?: HookPatch;
};

function nowIso(): string {
  return new Date().toISOString();
}

function createExecutionClock(): ExecutionClock {
  return {
    startedAt: nowIso(),
    startedAtMs: Date.now(),
  };
}

function durationMs(start: number): number {
  return Math.max(0, Date.now() - start);
}

function withoutSignal<E extends string>(context: HookContext<E>): Record<string, unknown> {
  const { signal: _signal, ...rest } = context;
  return rest as Record<string, unknown>;
}

function createExecutionIssue<E extends string>(
  hook: HookDefinition<E>,
  event: E,
  error: unknown,
): HookExecutionIssue<E> {
  return {
    hookId: hook.id,
    hookName: hook.name,
    event,
    critical: hook.critical === true,
    error,
  };
}

function isAbortError(signal: AbortSignal | undefined, error: unknown): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

function resolveTimeoutMs<E extends string>(
  hook: HookDefinition<E>,
  options: ExecutorOptions<E>,
): number {
  return options.timeoutMs ?? hook.timeoutMs ?? 0;
}

function buildSuccessResult<E extends string>(
  hook: HookDefinition<E>,
  context: HookContext<E>,
  clock: ExecutionClock,
  patch?: HookPatch,
  extra?: Omit<
    Partial<HookInvocationResult<E>>,
    "status" | "startedAt" | "endedAt" | "durationMs" | "patch"
  >,
): ExecutorSuccess<E> {
  const endedAt = nowIso();
  const elapsed = durationMs(clock.startedAtMs);

  return {
    hookId: hook.id,
    hookName: hook.name,
    event: context.event,
    kind: hook.kind,
    status: patch?.controlPatch?.continue === false ? "blocked" : "success",
    startedAt: clock.startedAt,
    endedAt,
    durationMs: elapsed,
    patch,
    ...extra,
  };
}

function emitStarted<E extends string>(
  hook: HookDefinition<E>,
  context: HookContext<E>,
  options: ExecutorOptions<E>,
  clock: ExecutionClock,
): void {
  options.bus.emit({
    type: "started",
    hookId: hook.id,
    hookName: hook.name,
    event: context.event,
    kind: hook.kind,
    timestamp: clock.startedAt,
  });
}

function emitCompleted<E extends string>(
  hook: HookDefinition<E>,
  context: HookContext<E>,
  options: ExecutorOptions<E>,
  result: HookInvocationResult<E>,
): void {
  options.bus.emit({
    type: "completed",
    hookId: hook.id,
    hookName: hook.name,
    event: context.event,
    kind: hook.kind,
    durationMs: result.durationMs,
    timestamp: result.endedAt,
  });
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  hookName: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            reject(new HookTimeoutError(timeoutMs, hookName));
          }, timeoutMs)
        : undefined;

    const onAbort = (): void => {
      if (timer) clearTimeout(timer);
      reject(signal?.reason ?? new Error(`Hook "${hookName}" aborted`));
    };

    if (signal) {
      if (signal.aborted) {
        if (timer) clearTimeout(timer);
        reject(signal.reason ?? new Error(`Hook "${hookName}" aborted`));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    promise.then(
      (value) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function executeCallbackHook<E extends string>(
  hook: CallbackHookDefinition<E>,
  context: HookContext<E>,
  options: ExecutorOptions<E>,
  clock: ExecutionClock,
): Promise<ExecutorSuccess<E>> {
  emitStarted(hook, context, options, clock);

  const patch =
    (await withTimeout(
      Promise.resolve(hook.run(context)),
      resolveTimeoutMs(hook, options),
      hook.name,
      options.signal,
    )) ?? undefined;

  const result = buildSuccessResult(hook, context, clock, patch);
  emitCompleted(hook, context, options, result);
  return result;
}

async function executeCommandHook<E extends string>(
  hook: CommandHookDefinition<E>,
  context: HookContext<E>,
  options: ExecutorOptions<E>,
  clock: ExecutionClock,
): Promise<ExecutorSuccess<E>> {
  emitStarted(hook, context, options, clock);

  const input = hook.inputMode === "none" ? undefined : serializeHookInput(context);
  const timeoutMs = resolveTimeoutMs(hook, options);

  const commandResult = await withTimeout(
    new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      const child = spawn(hook.command, hook.args ?? [], {
        cwd: hook.cwd,
        env: { ...process.env, ...(hook.env ?? {}) },
        shell: hook.shell === true,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const onAbort = (): void => {
        child.kill();
      };

      child.stdout.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const output = buffer.toString("utf8");
        stdoutChunks.push(buffer);
        options.bus.emit({
          type: "progress",
          hookId: hook.id,
          hookName: hook.name,
          event: context.event,
          kind: hook.kind,
          output,
          stdout: output,
          timestamp: nowIso(),
        });
      });

      child.stderr.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const output = buffer.toString("utf8");
        stderrChunks.push(buffer);
        options.bus.emit({
          type: "progress",
          hookId: hook.id,
          hookName: hook.name,
          event: context.event,
          kind: hook.kind,
          output,
          stderr: output,
          timestamp: nowIso(),
        });
      });

      child.on("error", (error) => {
        options.signal?.removeEventListener("abort", onAbort);
        reject(error);
      });

      child.on("close", (code) => {
        options.signal?.removeEventListener("abort", onAbort);
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          code,
        });
      });

      if (options.signal) {
        if (options.signal.aborted) {
          onAbort();
        } else {
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      if (input) {
        child.stdin.write(input);
      }
      child.stdin.end();
    }),
    timeoutMs,
    hook.name,
    options.signal,
  );

  if (commandResult.code !== 0) {
    throw new HookCommandExitError(
      hook.command,
      commandResult.code,
      commandResult.stdout,
      commandResult.stderr,
    );
  }

  const patch = parseHookProtocolOutput(commandResult.stdout, hook.responseMode ?? "json");
  const result = buildSuccessResult(hook, context, clock, patch, {
    stdout: commandResult.stdout,
    stderr: commandResult.stderr,
    output: `${commandResult.stdout}${commandResult.stderr}`,
  });
  emitCompleted(hook, context, options, result);
  return result;
}

async function executeHttpHook<E extends string>(
  hook: HttpHookDefinition<E>,
  context: HookContext<E>,
  options: ExecutorOptions<E>,
  clock: ExecutionClock,
): Promise<ExecutorSuccess<E>> {
  emitStarted(hook, context, options, clock);

  const response = await withTimeout(
    fetch(hook.url, {
      method: hook.method ?? "POST",
      headers: {
        "content-type": "application/json",
        ...(hook.headers ?? {}),
      },
      body: serializeHookInput(context),
      signal: options.signal,
    }),
    resolveTimeoutMs(hook, options),
    hook.name,
    options.signal,
  );

  const text = await response.text();
  if (!response.ok) {
    throw new HookHttpError(hook.url, response.status, text);
  }

  const patch = parseHookProtocolOutput(text, hook.responseMode ?? "json");
  const result = buildSuccessResult(hook, context, clock, patch, {
    output: text,
    stdout: text,
    httpStatus: response.status,
  });
  emitCompleted(hook, context, options, result);
  return result;
}

function serializeHookInput<E extends string>(context: HookContext<E>): string {
  try {
    return JSON.stringify(withoutSignal(context));
  } catch (error) {
    throw new HookSerializationError("Failed to serialize hook input as JSON", { cause: error });
  }
}

export async function executeHookDefinition<E extends string>(
  hook: HookDefinition<E>,
  context: HookContext<E>,
  options: ExecutorOptions<E>,
): Promise<HookInvocationResult<E>> {
  const clock = createExecutionClock();

  try {
    switch (hook.kind) {
      case "callback":
        return await executeCallbackHook(hook, context, options, clock);
      case "command":
        return await executeCommandHook(hook, context, options, clock);
      case "http":
        return await executeHttpHook(hook, context, options, clock);
    }
  } catch (error) {
    const issue = createExecutionIssue(hook, context.event, error);
    const endedAt = nowIso();
    const elapsed = durationMs(clock.startedAtMs);

    if (error instanceof HookTimeoutError) {
      options.bus.emit({
        type: "timed_out",
        hookId: hook.id,
        hookName: hook.name,
        event: context.event,
        kind: hook.kind,
        durationMs: elapsed,
        timeoutMs: error.timeoutMs,
        timestamp: endedAt,
      });
      return {
        hookId: hook.id,
        hookName: hook.name,
        event: context.event,
        kind: hook.kind,
        status: "timed_out",
        startedAt: clock.startedAt,
        endedAt,
        durationMs: elapsed,
        issue,
      };
    }

    if (isAbortError(options.signal, error)) {
      options.bus.emit({
        type: "cancelled",
        hookId: hook.id,
        hookName: hook.name,
        event: context.event,
        kind: hook.kind,
        durationMs: elapsed,
        timestamp: endedAt,
      });
      return {
        hookId: hook.id,
        hookName: hook.name,
        event: context.event,
        kind: hook.kind,
        status: "cancelled",
        startedAt: clock.startedAt,
        endedAt,
        durationMs: elapsed,
        issue,
      };
    }

    options.bus.emit({
      type: "failed",
      hookId: hook.id,
      hookName: hook.name,
      event: context.event,
      kind: hook.kind,
      durationMs: elapsed,
      error,
      timestamp: endedAt,
    });

    return {
      hookId: hook.id,
      hookName: hook.name,
      event: context.event,
      kind: hook.kind,
      status: "error",
      startedAt: clock.startedAt,
      endedAt,
      durationMs: elapsed,
      issue,
    };
  }
}
