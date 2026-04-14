import type { HookCondition, HookContext, HookScope } from "./hook-types";

function getByPath(value: unknown, path: string): unknown {
  if (!path) return value;
  return path.split(".").reduce<unknown>((current, part) => {
    if (current == null || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[part];
  }, value);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
  const segments = pattern.split("*").map((segment) => escapeRegex(segment));
  return new RegExp(`^${segments.join(".*")}$`);
}

function matchesSingleCondition<E extends string>(
  context: HookContext<E>,
  condition: HookCondition,
): boolean {
  const candidate = getByPath(context, condition.path);

  switch (condition.operator) {
    case "exists":
      return candidate !== undefined;
    case "not_exists":
      return candidate === undefined;
    case "equals":
      return candidate === condition.value;
    case "not_equals":
      return candidate !== condition.value;
    case "in":
      return Array.isArray(condition.values) && condition.values.includes(candidate);
    case "not_in":
      return Array.isArray(condition.values) && !condition.values.includes(candidate);
    case "glob":
      return typeof candidate === "string" && typeof condition.value === "string"
        ? globToRegex(condition.value).test(candidate)
        : false;
    case "regex":
      return typeof candidate === "string" && typeof condition.value === "string"
        ? new RegExp(condition.value, condition.flags).test(candidate)
        : false;
  }
}

export function matchesHookConditions<E extends string>(
  context: HookContext<E>,
  conditions: readonly HookCondition[] | undefined,
): boolean {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every((condition) => matchesSingleCondition(context, condition));
}

export function matchesHookScope(
  hookScope: HookScope | undefined,
  runtimeScope: HookScope | undefined,
): boolean {
  if (!hookScope || hookScope.kind === "global") return true;
  if (!runtimeScope) return false;
  if (hookScope.kind !== runtimeScope.kind) return false;

  if (hookScope.kind === "session" && runtimeScope.kind === "session") {
    return hookScope.sessionId === runtimeScope.sessionId;
  }

  if (hookScope.kind === "run" && runtimeScope.kind === "run") {
    return hookScope.runId === runtimeScope.runId;
  }

  return false;
}
