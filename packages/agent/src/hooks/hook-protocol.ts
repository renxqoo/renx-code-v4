import { HookProtocolError } from "./hook-errors";
import { validatePatchBucket } from "./hook-validation";
import type { HookControlPatch, HookPatch } from "./hook-types";

type HookProtocolEnvelope = HookPatch;

const PATCH_KEYS = new Set<keyof HookPatch>([
  "metadataPatch",
  "sharedPatch",
  "eventDataPatch",
  "contextPatch",
  "modelRequestPatch",
  "modelResponsePatch",
  "toolInvocationPatch",
  "toolResultPatch",
  "observationPatch",
  "permissionsPatch",
  "controlPatch",
]);

const CONTROL_DECISIONS = new Set<NonNullable<HookControlPatch["decision"]>>([
  "allow",
  "deny",
  "approve",
  "block",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed);
  } catch {
    for (const line of trimmed.split("\n")) {
      const candidate = line.trim();
      if (!candidate.startsWith("{")) continue;
      try {
        return JSON.parse(candidate);
      } catch {
        // ignore per-line parse errors
      }
    }
  }
  return undefined;
}

function validateControlPatch(value: unknown): HookControlPatch | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new HookProtocolError("Hook controlPatch must be an object");
  }

  const patch = value as HookControlPatch;
  if (patch.continue !== undefined && typeof patch.continue !== "boolean") {
    throw new HookProtocolError("Hook controlPatch.continue must be a boolean");
  }
  if (patch.stopReason !== undefined && typeof patch.stopReason !== "string") {
    throw new HookProtocolError("Hook controlPatch.stopReason must be a string");
  }
  if (patch.suppressOutput !== undefined && typeof patch.suppressOutput !== "boolean") {
    throw new HookProtocolError("Hook controlPatch.suppressOutput must be a boolean");
  }
  if (patch.decision !== undefined && !CONTROL_DECISIONS.has(patch.decision)) {
    throw new HookProtocolError("Hook controlPatch.decision is invalid");
  }
  if (patch.tags !== undefined) {
    if (!Array.isArray(patch.tags) || patch.tags.some((tag) => typeof tag !== "string")) {
      throw new HookProtocolError("Hook controlPatch.tags must be a string array");
    }
  }
  return patch;
}

function validateHookProtocolEnvelope(value: Record<string, unknown>): HookProtocolEnvelope {
  for (const key of Object.keys(value)) {
    if (!PATCH_KEYS.has(key as keyof HookPatch)) {
      throw new HookProtocolError(`Unexpected hook protocol field: ${key}`);
    }
  }

  return {
    metadataPatch: validatePatchBucket(value.metadataPatch, "metadataPatch"),
    sharedPatch: validatePatchBucket(value.sharedPatch, "sharedPatch"),
    eventDataPatch: validatePatchBucket(value.eventDataPatch, "eventDataPatch"),
    contextPatch: validatePatchBucket(value.contextPatch, "contextPatch"),
    modelRequestPatch: validatePatchBucket(value.modelRequestPatch, "modelRequestPatch"),
    modelResponsePatch: validatePatchBucket(value.modelResponsePatch, "modelResponsePatch"),
    toolInvocationPatch: validatePatchBucket(value.toolInvocationPatch, "toolInvocationPatch"),
    toolResultPatch: validatePatchBucket(value.toolResultPatch, "toolResultPatch"),
    observationPatch: validatePatchBucket(value.observationPatch, "observationPatch"),
    permissionsPatch: validatePatchBucket(value.permissionsPatch, "permissionsPatch"),
    controlPatch: validateControlPatch(value.controlPatch),
  };
}

export function parseHookProtocolOutput(
  text: string,
  mode: "json" | "text",
): HookProtocolEnvelope | undefined {
  if (mode === "text") return undefined;

  const parsed = tryParseJson(text);
  if (parsed === undefined) {
    return undefined;
  }
  if (!isPlainObject(parsed)) {
    throw new HookProtocolError("Hook JSON output must be an object");
  }
  return validateHookProtocolEnvelope(parsed);
}
