import type { HookExecutionIssue, HookEventName } from "./hook-types";

export class HookError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HookError";
  }
}

export class HookRegistrationError extends HookError {
  constructor(message: string) {
    super(message);
    this.name = "HookRegistrationError";
  }
}

export class HookValidationError extends HookError {
  constructor(message: string) {
    super(message);
    this.name = "HookValidationError";
  }
}

export class HookProtocolError extends HookError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HookProtocolError";
  }
}

export class HookSerializationError extends HookError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HookSerializationError";
  }
}

export class HookTimeoutError extends HookError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, hookName: string) {
    super(`Hook "${hookName}" timed out after ${timeoutMs}ms`);
    this.name = "HookTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class HookCommandExitError extends HookError {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(command: string, exitCode: number | null, stdout: string, stderr: string) {
    super(`Hook command "${command}" exited with code ${exitCode ?? "unknown"}`);
    this.name = "HookCommandExitError";
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export class HookHttpError extends HookError {
  readonly status: number;
  readonly responseText: string;

  constructor(url: string, status: number, responseText: string) {
    super(`Hook HTTP request to "${url}" failed with status ${status}`);
    this.name = "HookHttpError";
    this.status = status;
    this.responseText = responseText;
  }
}

export class HookExecutionError<E extends string = HookEventName> extends HookError {
  readonly issue: HookExecutionIssue<E>;

  constructor(issue: HookExecutionIssue<E>) {
    super(`Hook "${issue.hookName}" failed during event "${issue.event}"`, {
      cause: issue.error,
    });
    this.name = "HookExecutionError";
    this.issue = issue;
  }
}
