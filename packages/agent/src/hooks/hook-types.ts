export type HookEventName = string;

export const DEFAULT_HOOK_EVENTS = [
  "beforeRun",
  "beforeStep",
  "beforeBuildContext",
  "beforeModelCall",
  "afterModelCall",
  "beforeToolExecution",
  "afterToolExecution",
  "beforeFinish",
] as const;

export type HookPhase = (typeof DEFAULT_HOOK_EVENTS)[number];

export type HookPatchBucket = Record<string, unknown>;

export type HookScope =
  | { kind: "global" }
  | { kind: "session"; sessionId: string }
  | { kind: "run"; runId: string };

export type HookControlPatch = {
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  decision?: "allow" | "deny" | "approve" | "block";
  tags?: string[];
};

export type HookContext<E extends string = HookPhase> = {
  event: E;
  signal?: AbortSignal;
  scope?: HookScope;
  run?: unknown;
  step?: unknown;
  metadata?: HookPatchBucket;
  shared?: HookPatchBucket;
  eventData?: HookPatchBucket;
  context?: HookPatchBucket;
  modelRequest?: HookPatchBucket;
  modelResponse?: HookPatchBucket;
  toolInvocation?: HookPatchBucket;
  toolResult?: HookPatchBucket;
  observation?: HookPatchBucket;
  permissions?: HookPatchBucket;
  control?: HookControlPatch;
  error?: unknown;
};

export type HookPatch = {
  metadataPatch?: HookPatchBucket;
  sharedPatch?: HookPatchBucket;
  eventDataPatch?: HookPatchBucket;
  contextPatch?: HookPatchBucket;
  modelRequestPatch?: HookPatchBucket;
  modelResponsePatch?: HookPatchBucket;
  toolInvocationPatch?: HookPatchBucket;
  toolResultPatch?: HookPatchBucket;
  observationPatch?: HookPatchBucket;
  permissionsPatch?: HookPatchBucket;
  controlPatch?: HookControlPatch;
};

export type HookHandlerResult = void | HookPatch;

export type HookConditionOperator =
  | "equals"
  | "not_equals"
  | "in"
  | "not_in"
  | "exists"
  | "not_exists"
  | "glob"
  | "regex";

export type HookCondition = {
  path: string;
  operator: HookConditionOperator;
  value?: unknown;
  values?: unknown[];
  flags?: string;
};

export type HookSource = "core" | "plugin" | "user" | "session" | "runtime";

export type HookDefinitionBase<E extends string = HookPhase> = {
  id: string;
  name: string;
  event: E;
  description?: string;
  enabled?: boolean;
  order?: number;
  critical?: boolean;
  timeoutMs?: number;
  scope?: HookScope;
  source?: HookSource;
  tags?: string[];
  when?: HookCondition[];
  matches?: (context: Readonly<HookContext<E>>) => boolean | Promise<boolean>;
};

export type CallbackHookDefinition<E extends string = HookPhase> = HookDefinitionBase<E> & {
  kind: "callback";
  run: (context: Readonly<HookContext<E>>) => HookHandlerResult | Promise<HookHandlerResult>;
};

export type CommandHookDefinition<E extends string = HookPhase> = HookDefinitionBase<E> & {
  kind: "command";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  shell?: boolean;
  inputMode?: "json" | "none";
  responseMode?: "json" | "text";
};

export type HttpHookDefinition<E extends string = HookPhase> = HookDefinitionBase<E> & {
  kind: "http";
  url: string;
  method?: "POST" | "PUT" | "PATCH";
  headers?: Record<string, string>;
  responseMode?: "json" | "text";
};

export type HookDefinition<E extends string = HookPhase> =
  | CallbackHookDefinition<E>
  | CommandHookDefinition<E>
  | HttpHookDefinition<E>;

export type HookExecutionMode = "serial" | "parallel";

export type HookExecutionInput<E extends string = HookPhase> = Omit<HookContext<E>, "event">;

export type HookExecutionIssue<E extends string = HookPhase> = {
  hookId: string;
  hookName: string;
  event: E;
  critical: boolean;
  error: unknown;
};

export type HookExecutionStatus =
  | "success"
  | "error"
  | "blocked"
  | "cancelled"
  | "timed_out"
  | "skipped";

export type HookInvocationResult<E extends string = HookPhase> = {
  hookId: string;
  hookName: string;
  event: E;
  kind: HookDefinition<E>["kind"];
  status: HookExecutionStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  patch?: HookPatch;
  stdout?: string;
  stderr?: string;
  output?: string;
  httpStatus?: number;
  issue?: HookExecutionIssue<E>;
};

export type HookEngineResult<E extends string = HookPhase> = {
  event: E;
  context: HookContext<E>;
  matchedHooks: string[];
  executedHooks: string[];
  invocations: HookInvocationResult<E>[];
  issues: HookExecutionIssue<E>[];
  stopped: boolean;
  stopReason?: string;
};

export type HookEngineExecuteOptions<E extends string = HookPhase> = {
  mode?: HookExecutionMode;
  signal?: AbortSignal;
  timeoutMs?: number;
  scope?: HookScope;
  sourceFilter?: HookSource[];
  tagFilter?: string[];
  stopOnBlock?: boolean;
  failOnError?: boolean;
};

export type HookEngineDefaults = {
  mode?: HookExecutionMode;
  timeoutMs?: number;
  stopOnBlock?: boolean;
  failOnError?: boolean;
};

export type HookRegistryFilter<E extends string = HookPhase> = {
  event?: E;
  scope?: HookScope;
  sourceFilter?: HookSource[];
  tagFilter?: string[];
};

export type HookRegistrySnapshot<E extends string = HookPhase> = {
  size: number;
  hooks: HookDefinition<E>[];
};

export function createCallbackHook<E extends string = HookPhase>(
  definition: Omit<CallbackHookDefinition<E>, "kind">,
): CallbackHookDefinition<E> {
  return { kind: "callback", ...definition };
}

export function createCommandHook<E extends string = HookPhase>(
  definition: Omit<CommandHookDefinition<E>, "kind">,
): CommandHookDefinition<E> {
  return { kind: "command", ...definition };
}

export function createHttpHook<E extends string = HookPhase>(
  definition: Omit<HttpHookDefinition<E>, "kind">,
): HttpHookDefinition<E> {
  return { kind: "http", ...definition };
}
