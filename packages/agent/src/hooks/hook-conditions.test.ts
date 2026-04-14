import { describe, expect, it } from "vitest";

import { matchesHookConditions, matchesHookScope } from "./hook-conditions";
import type { HookContext } from "./hook-types";

const baseContext: HookContext<"beforeToolExecution"> = {
  event: "beforeToolExecution",
  toolInvocation: {
    toolName: "shell",
    command: "pnpm test",
  },
  metadata: {
    env: "prod",
    region: "cn",
  },
};

describe("hook-conditions", () => {
  it("supports equality, membership, existence, glob and regex operators", () => {
    expect(
      matchesHookConditions(baseContext, [
        { path: "toolInvocation.toolName", operator: "equals", value: "shell" },
        { path: "metadata.env", operator: "not_equals", value: "dev" },
        { path: "metadata.region", operator: "in", values: ["cn", "us"] },
        { path: "metadata.missing", operator: "not_exists" },
        { path: "toolInvocation.command", operator: "glob", value: "pnpm*" },
        { path: "toolInvocation.command", operator: "regex", value: "^pnpm\\s+test$" },
      ]),
    ).toBe(true);
  });

  it("returns false when any condition does not match", () => {
    expect(
      matchesHookConditions(baseContext, [
        { path: "toolInvocation.toolName", operator: "equals", value: "shell" },
        { path: "metadata.region", operator: "not_in", values: ["cn", "hk"] },
      ]),
    ).toBe(false);
  });

  it("treats empty condition lists as matched", () => {
    expect(matchesHookConditions(baseContext, undefined)).toBe(true);
    expect(matchesHookConditions(baseContext, [])).toBe(true);
  });

  it("matches global scope and rejects mismatched runtime scopes", () => {
    expect(matchesHookScope(undefined, undefined)).toBe(true);
    expect(matchesHookScope({ kind: "global" }, undefined)).toBe(true);
    expect(
      matchesHookScope(
        { kind: "session", sessionId: "s1" },
        { kind: "session", sessionId: "s1" },
      ),
    ).toBe(true);
    expect(
      matchesHookScope(
        { kind: "session", sessionId: "s1" },
        { kind: "session", sessionId: "s2" },
      ),
    ).toBe(false);
    expect(
      matchesHookScope({ kind: "run", runId: "r1" }, { kind: "session", sessionId: "s1" }),
    ).toBe(false);
    expect(matchesHookScope({ kind: "run", runId: "r1" }, undefined)).toBe(false);
  });
});
