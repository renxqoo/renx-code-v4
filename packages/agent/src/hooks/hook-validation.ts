import { HookValidationError } from "./hook-errors";
import type {
  HookCondition,
  HookDefinition,
  HookPatchBucket,
  HookScope,
  HookSource,
} from "./hook-types";

const ALLOWED_SOURCES: HookSource[] = ["core", "plugin", "user", "session", "runtime"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function ensureNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HookValidationError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function ensureOptionalStringRecord(
  value: unknown,
  label: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new HookValidationError(`${label} must be an object`);
  }

  const entries = Object.entries(value);
  for (const [key, entry] of entries) {
    ensureNonEmptyString(key, `${label} key`);
    if (typeof entry !== "string") {
      throw new HookValidationError(`${label}.${key} must be a string`);
    }
  }

  return value as Record<string, string>;
}

function ensureOptionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new HookValidationError(`${label} must be an array`);
  }
  return value.map((entry, index) => ensureNonEmptyString(entry, `${label}[${index}]`));
}

function ensureOptionalBucket(value: unknown, label: string): HookPatchBucket | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new HookValidationError(`${label} must be an object`);
  }
  return value as HookPatchBucket;
}

function validateScope(scope: HookScope | undefined): void {
  if (!scope) return;

  switch (scope.kind) {
    case "global":
      return;
    case "session":
      ensureNonEmptyString(scope.sessionId, "scope.sessionId");
      return;
    case "run":
      ensureNonEmptyString(scope.runId, "scope.runId");
      return;
    default:
      throw new HookValidationError(`Unsupported hook scope kind: ${(scope as HookScope).kind}`);
  }
}

function validateCondition(condition: HookCondition, index: number): void {
  ensureNonEmptyString(condition.path, `when[${index}].path`);

  switch (condition.operator) {
    case "exists":
    case "not_exists":
      return;
    case "equals":
    case "not_equals":
    case "glob":
    case "regex":
      if (condition.value === undefined) {
        throw new HookValidationError(`when[${index}].value is required`);
      }
      if (condition.operator === "glob" || condition.operator === "regex") {
        if (typeof condition.value !== "string") {
          throw new HookValidationError(`when[${index}].value must be a string`);
        }
      }
      if (condition.operator === "regex" && condition.flags !== undefined) {
        ensureNonEmptyString(condition.flags, `when[${index}].flags`);
      }
      return;
    case "in":
    case "not_in":
      if (!Array.isArray(condition.values) || condition.values.length === 0) {
        throw new HookValidationError(`when[${index}].values must be a non-empty array`);
      }
      return;
    default:
      throw new HookValidationError(
        `Unsupported condition operator: ${(condition as HookCondition).operator}`,
      );
  }
}

export function validateHookDefinition<E extends string>(hook: HookDefinition<E>): void {
  ensureNonEmptyString(hook.id, "hook.id");
  ensureNonEmptyString(hook.name, "hook.name");
  ensureNonEmptyString(hook.event, "hook.event");

  if (hook.description !== undefined) ensureNonEmptyString(hook.description, "hook.description");
  if (hook.order !== undefined && !Number.isFinite(hook.order)) {
    throw new HookValidationError("hook.order must be a finite number");
  }
  if (
    hook.timeoutMs !== undefined &&
    (!Number.isFinite(hook.timeoutMs) || hook.timeoutMs < 0)
  ) {
    throw new HookValidationError("hook.timeoutMs must be a non-negative number");
  }

  validateScope(hook.scope);
  ensureOptionalStringArray(hook.tags, "hook.tags");

  if (hook.source !== undefined && !ALLOWED_SOURCES.includes(hook.source)) {
    throw new HookValidationError(`Unsupported hook.source: ${hook.source}`);
  }
  if (hook.when) {
    for (const [index, condition] of hook.when.entries()) {
      validateCondition(condition, index);
    }
  }
  if (hook.matches !== undefined && typeof hook.matches !== "function") {
    throw new HookValidationError("hook.matches must be a function");
  }

  switch (hook.kind) {
    case "callback":
      if (typeof hook.run !== "function") {
        throw new HookValidationError("callback hook.run must be a function");
      }
      return;
    case "command":
      ensureNonEmptyString(hook.command, "command.command");
      if (hook.args !== undefined) {
        ensureOptionalStringArray(hook.args, "command.args");
      }
      if (hook.cwd !== undefined) {
        ensureNonEmptyString(hook.cwd, "command.cwd");
      }
      ensureOptionalStringRecord(hook.env, "command.env");
      return;
    case "http": {
      const url = ensureNonEmptyString(hook.url, "http.url");
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new HookValidationError("http.url must use http or https");
        }
      } catch (error) {
        if (error instanceof HookValidationError) throw error;
        throw new HookValidationError("http.url must be a valid absolute URL");
      }
      ensureOptionalStringRecord(hook.headers, "http.headers");
      return;
    }
    default:
      throw new HookValidationError(`Unsupported hook kind: ${(hook as HookDefinition<E>).kind}`);
  }
}

export function validatePatchBucket(value: unknown, label: string): HookPatchBucket | undefined {
  return ensureOptionalBucket(value, label);
}
