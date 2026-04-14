import { describe, expect, it } from "vitest";

import { HookValidationError } from "./hook-errors";
import { createCallbackHook, createCommandHook, createHttpHook } from "./hook-types";
import { validateHookDefinition, validatePatchBucket } from "./hook-validation";

describe("hook-validation", () => {
  it("accepts valid callback, command and http hook definitions", () => {
    expect(() =>
      validateHookDefinition(
        createCallbackHook({
          id: "cb",
          name: "cb",
          event: "beforeRun",
          description: "callback hook",
          source: "core",
          tags: ["policy"],
          when: [{ path: "metadata.kind", operator: "exists" }],
          run: () => undefined,
        }),
      ),
    ).not.toThrow();

    expect(() =>
      validateHookDefinition(
        createCommandHook({
          id: "cmd",
          name: "cmd",
          event: "beforeRun",
          command: "node",
          args: ["-e", "process.exit(0)"],
          cwd: "/tmp",
          env: { NODE_ENV: "test" },
        }),
      ),
    ).not.toThrow();

    expect(() =>
      validateHookDefinition(
        createHttpHook({
          id: "http",
          name: "http",
          event: "beforeRun",
          url: "https://example.com/hooks",
          headers: { authorization: "Bearer token" },
        }),
      ),
    ).not.toThrow();
  });

  it("rejects invalid condition, scope, source, callback, command and http definitions", () => {
    expect(() =>
      validateHookDefinition({
        kind: "callback",
        id: "bad-scope",
        name: "bad-scope",
        event: "beforeRun",
        scope: { kind: "tenant" } as never,
        run: () => undefined,
      }),
    ).toThrow(HookValidationError);

    expect(() =>
      validateHookDefinition({
        kind: "callback",
        id: "bad-source",
        name: "bad-source",
        event: "beforeRun",
        source: "unknown" as never,
        run: () => undefined,
      }),
    ).toThrow(HookValidationError);

    expect(() =>
      validateHookDefinition({
        kind: "callback",
        id: "bad-condition",
        name: "bad-condition",
        event: "beforeRun",
        when: [{ path: "metadata.kind", operator: "regex", value: 123 } as never],
        run: () => undefined,
      }),
    ).toThrow(HookValidationError);

    expect(() =>
      validateHookDefinition({
        kind: "callback",
        id: "bad-callback",
        name: "bad-callback",
        event: "beforeRun",
        run: "not-fn" as never,
      }),
    ).toThrow(HookValidationError);

    expect(() =>
      validateHookDefinition({
        kind: "command",
        id: "bad-command",
        name: "bad-command",
        event: "beforeRun",
        command: "node",
        args: [123] as never,
      }),
    ).toThrow(HookValidationError);

    expect(() =>
      validateHookDefinition({
        kind: "http",
        id: "bad-http",
        name: "bad-http",
        event: "beforeRun",
        url: "ftp://example.com/hook",
      }),
    ).toThrow(HookValidationError);
  });

  it("rejects invalid tags, env records, numeric config and patch buckets", () => {
    expect(() =>
      validateHookDefinition({
        kind: "callback",
        id: "bad-tags",
        name: "bad-tags",
        event: "beforeRun",
        tags: "policy" as never,
        run: () => undefined,
      }),
    ).toThrow(HookValidationError);

    expect(() =>
      validateHookDefinition({
        kind: "command",
        id: "bad-env",
        name: "bad-env",
        event: "beforeRun",
        command: "node",
        env: { PORT: 3000 } as never,
      }),
    ).toThrow(HookValidationError);

    expect(() =>
      validateHookDefinition({
        kind: "callback",
        id: "bad-timeout",
        name: "bad-timeout",
        event: "beforeRun",
        timeoutMs: -1,
        run: () => undefined,
      }),
    ).toThrow(HookValidationError);

    expect(() => validatePatchBucket([], "bucket")).toThrow(HookValidationError);
  });
});
