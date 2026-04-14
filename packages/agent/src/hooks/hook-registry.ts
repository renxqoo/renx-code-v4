import { HookRegistrationError } from "./hook-errors";
import { matchesHookConditions, matchesHookScope } from "./hook-conditions";
import { validateHookDefinition } from "./hook-validation";
import type {
  HookContext,
  HookDefinition,
  HookEventName,
  HookRegistryFilter,
  HookRegistrySnapshot,
} from "./hook-types";

type RegisteredHook<E extends string> = HookDefinition<E> & { registrationOrder: number };

export class HookRegistry<E extends string = HookEventName> {
  private readonly hooks = new Map<string, RegisteredHook<E>>();
  private registrationCounter = 0;

  get size(): number {
    return this.hooks.size;
  }

  has(id: string): boolean {
    return this.hooks.has(id);
  }

  register(hook: HookDefinition<E>): void {
    validateHookDefinition(hook);
    if (this.hooks.has(hook.id)) {
      throw new HookRegistrationError(`Hook "${hook.id}" is already registered`);
    }
    this.hooks.set(hook.id, {
      ...hook,
      registrationOrder: ++this.registrationCounter,
    });
  }

  registerMany(hooks: Iterable<HookDefinition<E>>): void {
    for (const hook of hooks) this.register(hook);
  }

  unregister(id: string): boolean {
    return this.hooks.delete(id);
  }

  clear(filter?: HookRegistryFilter<E>): void {
    if (!filter) {
      this.hooks.clear();
      return;
    }
    for (const hook of this.list(filter)) {
      this.hooks.delete(hook.id);
    }
  }

  get(id: string): HookDefinition<E> | undefined {
    const hook = this.hooks.get(id);
    if (!hook) return undefined;
    return this.stripRegistration(hook);
  }

  ids(filter?: HookRegistryFilter<E>): string[] {
    return this.list(filter).map((hook) => hook.id);
  }

  snapshot(filter?: HookRegistryFilter<E>): HookRegistrySnapshot<E> {
    const hooks = this.list(filter);
    return {
      size: hooks.length,
      hooks,
    };
  }

  list(filter?: HookRegistryFilter<E>): HookDefinition<E>[] {
    return Array.from(this.hooks.values())
      .filter((hook) => this.matchesFilter(hook, filter))
      .sort((a, b) => {
        const orderDelta = (a.order ?? 0) - (b.order ?? 0);
        if (orderDelta !== 0) return orderDelta;
        return a.registrationOrder - b.registrationOrder;
      })
      .map((hook) => this.stripRegistration(hook));
  }

  async findMatching<TEvent extends E>(
    event: TEvent,
    context: HookContext<TEvent>,
    filter?: Omit<HookRegistryFilter<TEvent>, "event">,
  ): Promise<HookDefinition<TEvent>[]> {
    const hooks = this.list({
      ...(filter ?? {}),
      event,
    } as HookRegistryFilter<E>) as HookDefinition<TEvent>[];

    const matched: HookDefinition<TEvent>[] = [];
    for (const hook of hooks) {
      if (hook.enabled === false) continue;
      if (!matchesHookScope(hook.scope, context.scope)) continue;
      if (!matchesHookConditions(context, hook.when)) continue;
      if (hook.matches) {
        const ok = await hook.matches(context);
        if (!ok) continue;
      }
      matched.push(hook);
    }
    return matched;
  }

  private matchesFilter(
    hook: RegisteredHook<E>,
    filter: HookRegistryFilter<E> | undefined,
  ): boolean {
    if (!filter) return true;
    if (filter.event !== undefined && hook.event !== filter.event) return false;
    if (filter.scope && !matchesHookScope(hook.scope, filter.scope)) return false;
    if (
      filter.sourceFilter &&
      filter.sourceFilter.length > 0 &&
      !filter.sourceFilter.includes(hook.source ?? "runtime")
    ) {
      return false;
    }
    if (
      filter.tagFilter &&
      filter.tagFilter.length > 0 &&
      !filter.tagFilter.every((tag) => hook.tags?.includes(tag))
    ) {
      return false;
    }
    return true;
  }

  private stripRegistration<T extends E>(hook: RegisteredHook<T>): HookDefinition<T> {
    const { registrationOrder: _registrationOrder, ...rest } = hook;
    return rest;
  }
}
