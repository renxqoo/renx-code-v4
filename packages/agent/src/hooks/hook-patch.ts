import type { HookContext, HookControlPatch, HookPatch, HookPatchBucket } from "./hook-types";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (Object.prototype.toString.call(value) !== "[object Object]") {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function cloneHookValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneHookValue(item)) as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = cloneHookValue(entry);
    }
    return out as T;
  }
  return value;
}

export function mergeHookBuckets(
  base: HookPatchBucket | undefined,
  patch: HookPatchBucket | undefined,
): HookPatchBucket | undefined {
  if (!patch) return base;
  if (!base) return cloneHookValue(patch);

  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = next[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      next[key] = mergeHookBuckets(current, value);
      continue;
    }
    next[key] = cloneHookValue(value);
  }
  return next;
}

export function mergeControlPatches(
  base: HookControlPatch | undefined,
  patch: HookControlPatch | undefined,
): HookControlPatch | undefined {
  if (!patch) return base;
  if (!base) {
    return {
      ...patch,
      tags: patch.tags ? [...patch.tags] : undefined,
    };
  }

  return {
    continue: patch.continue ?? base.continue,
    stopReason: patch.stopReason ?? base.stopReason,
    suppressOutput: patch.suppressOutput ?? base.suppressOutput,
    decision: patch.decision ?? base.decision,
    tags: dedupeStrings([...(base.tags ?? []), ...(patch.tags ?? [])]),
  };
}

function dedupeStrings(values: string[]): string[] | undefined {
  if (values.length === 0) return undefined;
  return Array.from(new Set(values));
}

export function applyHookPatch<E extends string>(
  context: HookContext<E>,
  patch: HookPatch,
): HookContext<E> {
  return {
    ...context,
    metadata: mergeHookBuckets(context.metadata, patch.metadataPatch),
    shared: mergeHookBuckets(context.shared, patch.sharedPatch),
    eventData: mergeHookBuckets(context.eventData, patch.eventDataPatch),
    context: mergeHookBuckets(context.context, patch.contextPatch),
    modelRequest: mergeHookBuckets(context.modelRequest, patch.modelRequestPatch),
    modelResponse: mergeHookBuckets(context.modelResponse, patch.modelResponsePatch),
    toolInvocation: mergeHookBuckets(context.toolInvocation, patch.toolInvocationPatch),
    toolResult: mergeHookBuckets(context.toolResult, patch.toolResultPatch),
    observation: mergeHookBuckets(context.observation, patch.observationPatch),
    permissions: mergeHookBuckets(context.permissions, patch.permissionsPatch),
    control: mergeControlPatches(context.control, patch.controlPatch),
  };
}
