import { describe, expect, it } from "vitest";

import { HookRegistrationError } from "./hook-errors";
import { HookRegistry } from "./hook-registry";
import { createCallbackHook } from "./hook-types";

describe("hook-registry", () => {
  it("sorts hooks by order then registration order", () => {
    const registry = new HookRegistry();

    registry.register(
      createCallbackHook({
        id: "b",
        name: "b",
        event: "beforeRun",
        order: 20,
        run: () => undefined,
      }),
    );
    registry.register(
      createCallbackHook({
        id: "a1",
        name: "a1",
        event: "beforeRun",
        order: 10,
        run: () => undefined,
      }),
    );
    registry.register(
      createCallbackHook({
        id: "a2",
        name: "a2",
        event: "beforeRun",
        order: 10,
        run: () => undefined,
      }),
    );

    expect(registry.ids()).toEqual(["a1", "a2", "b"]);
  });

  it("rejects duplicate registrations and supports unregister/get/has", () => {
    const registry = new HookRegistry();
    const hook = createCallbackHook({
      id: "dup",
      name: "dup",
      event: "beforeRun",
      run: () => undefined,
    });

    registry.register(hook);
    expect(registry.has("dup")).toBe(true);
    expect(registry.get("dup")?.id).toBe("dup");
    expect(() => registry.register(hook)).toThrow(HookRegistrationError);
    expect(registry.unregister("dup")).toBe(true);
    expect(registry.get("dup")).toBeUndefined();
  });

  it("supports filter-based list, snapshot, clear and async matching", async () => {
    const registry = new HookRegistry();

    registry.register(
      createCallbackHook({
        id: "core",
        name: "core",
        event: "beforeToolExecution",
        source: "core",
        tags: ["policy", "security"],
        run: () => undefined,
      }),
    );
    registry.register(
      createCallbackHook({
        id: "plugin",
        name: "plugin",
        event: "beforeToolExecution",
        source: "plugin",
        scope: { kind: "session", sessionId: "s1" },
        matches: async (context) => context.metadata?.allow === true,
        run: () => undefined,
      }),
    );
    registry.register(
      createCallbackHook({
        id: "disabled",
        name: "disabled",
        event: "beforeToolExecution",
        enabled: false,
        run: () => undefined,
      }),
    );

    expect(
      registry.ids({
        event: "beforeToolExecution",
        sourceFilter: ["core"],
        tagFilter: ["policy"],
      }),
    ).toEqual(["core"]);

    expect(
      registry.snapshot({
        event: "beforeToolExecution",
      }).size,
    ).toBe(3);

    const matched = await registry.findMatching(
      "beforeToolExecution",
      {
        event: "beforeToolExecution",
        scope: { kind: "session", sessionId: "s1" },
        metadata: { allow: true },
      },
      { sourceFilter: ["core", "plugin"] },
    );

    expect(matched.map((hook) => hook.id)).toEqual(["core", "plugin"]);

    registry.clear({ sourceFilter: ["plugin"] });
    expect(registry.has("plugin")).toBe(false);
    expect(registry.size).toBe(2);
  });
});
