import { HookExecutionError } from "./hook-errors";
import { HookEventBus } from "./hook-events";
import { executeHookDefinition } from "./hook-executors";
import { applyHookPatch, cloneHookValue } from "./hook-patch";
import { HookRegistry } from "./hook-registry";
import type {
  HookContext,
  HookEngineExecuteOptions,
  HookEngineDefaults,
  HookEngineResult,
  HookEventName,
  HookExecutionInput,
  HookExecutionIssue,
  HookInvocationResult,
} from "./hook-types";

function normalizeContext<E extends string>(
  event: E,
  input: HookExecutionInput<E>,
  signal: AbortSignal | undefined,
  scope: HookEngineExecuteOptions<E>["scope"],
): HookContext<E> {
  return {
    event,
    signal,
    scope,
    run: input.run,
    step: input.step,
    metadata: input.metadata ? cloneHookValue(input.metadata) : undefined,
    shared: input.shared ? cloneHookValue(input.shared) : undefined,
    eventData: input.eventData ? cloneHookValue(input.eventData) : undefined,
    context: input.context ? cloneHookValue(input.context) : undefined,
    modelRequest: input.modelRequest ? cloneHookValue(input.modelRequest) : undefined,
    modelResponse: input.modelResponse ? cloneHookValue(input.modelResponse) : undefined,
    toolInvocation: input.toolInvocation ? cloneHookValue(input.toolInvocation) : undefined,
    toolResult: input.toolResult ? cloneHookValue(input.toolResult) : undefined,
    observation: input.observation ? cloneHookValue(input.observation) : undefined,
    permissions: input.permissions ? cloneHookValue(input.permissions) : undefined,
    control: input.control ? cloneHookValue(input.control) : undefined,
    error: input.error,
  };
}

export class HookEngine<E extends string = HookEventName> {
  readonly registry: HookRegistry<E>;
  readonly events: HookEventBus;
  readonly defaults: HookEngineDefaults;

  constructor(options?: {
    registry?: HookRegistry<E>;
    events?: HookEventBus;
    defaults?: HookEngineDefaults;
  }) {
    this.registry = options?.registry ?? new HookRegistry<E>();
    this.events = options?.events ?? new HookEventBus();
    this.defaults = options?.defaults ?? {};
  }

  async execute<TEvent extends E>(
    event: TEvent,
    input: HookExecutionInput<TEvent>,
    options?: HookEngineExecuteOptions<TEvent>,
  ): Promise<HookEngineResult<TEvent>> {
    const mode = options?.mode ?? this.defaults.mode ?? "serial";
    const stopOnBlock = options?.stopOnBlock ?? this.defaults.stopOnBlock ?? true;
    const timeoutMs = options?.timeoutMs ?? this.defaults.timeoutMs;
    const failOnError = options?.failOnError ?? this.defaults.failOnError ?? false;
    let context = normalizeContext(event, input, options?.signal, options?.scope);
    const matchedHooks = await this.registry.findMatching(event, context, {
      sourceFilter: options?.sourceFilter,
      tagFilter: options?.tagFilter,
      scope: options?.scope,
    });

    const invocations: HookInvocationResult<TEvent>[] = [];
    const issues: HookExecutionIssue<TEvent>[] = [];
    const executedHooks: string[] = [];

    if (mode === "parallel") {
      const results = await Promise.all(
        matchedHooks.map((hook) =>
          executeHookDefinition(hook, context, {
            bus: this.events,
            signal: options?.signal,
            timeoutMs,
          }),
        ),
      );

      for (const result of results) {
        invocations.push(result);
        if (result.status === "success" || result.status === "blocked") {
          executedHooks.push(result.hookName);
          if (result.patch) {
            context = applyHookPatch(context, result.patch);
          }
        }
        if (result.issue) {
          issues.push(result.issue);
          if (result.issue.critical || failOnError) {
            throw new HookExecutionError(result.issue);
          }
        }
      }
    } else {
      for (const hook of matchedHooks) {
        const result = await executeHookDefinition(hook, context, {
          bus: this.events,
          signal: options?.signal,
          timeoutMs,
        });
        invocations.push(result);

        if (result.status === "success" || result.status === "blocked") {
          executedHooks.push(result.hookName);
          if (result.patch) {
            context = applyHookPatch(context, result.patch);
          }
        }

        if (result.issue) {
          issues.push(result.issue);
          if (result.issue.critical || failOnError) {
            throw new HookExecutionError(result.issue);
          }
        }

        if (stopOnBlock && context.control?.continue === false) {
          break;
        }
      }
    }

    return {
      event,
      context,
      matchedHooks: matchedHooks.map((hook) => hook.name),
      executedHooks,
      invocations,
      issues,
      stopped: context.control?.continue === false,
      stopReason: context.control?.stopReason,
    };
  }
}
