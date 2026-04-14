import { describe, expect, it } from "vitest";

import { HookProtocolError } from "./hook-errors";
import { parseHookProtocolOutput } from "./hook-protocol";

describe("hook-protocol", () => {
  it("returns undefined in text mode", () => {
    expect(parseHookProtocolOutput('{"metadataPatch":{"ok":true}}', "text")).toBeUndefined();
  });

  it("parses line-delimited json output", () => {
    expect(
      parseHookProtocolOutput('log line\n{"metadataPatch":{"ok":true}}\n', "json"),
    ).toEqual({
      metadataPatch: { ok: true },
      sharedPatch: undefined,
      eventDataPatch: undefined,
      contextPatch: undefined,
      modelRequestPatch: undefined,
      modelResponsePatch: undefined,
      toolInvocationPatch: undefined,
      toolResultPatch: undefined,
      observationPatch: undefined,
      permissionsPatch: undefined,
      controlPatch: undefined,
    });
  });

  it("returns undefined for empty or non-json output", () => {
    expect(parseHookProtocolOutput("", "json")).toBeUndefined();
    expect(parseHookProtocolOutput("not json", "json")).toBeUndefined();
  });

  it("rejects unexpected protocol fields", () => {
    expect(() =>
      parseHookProtocolOutput('{"metadataPatch":{"ok":true},"badField":1}', "json"),
    ).toThrow(HookProtocolError);
  });

  it("rejects invalid control patches", () => {
    expect(() =>
      parseHookProtocolOutput('{"controlPatch":{"continue":"yes"}}', "json"),
    ).toThrow(HookProtocolError);

    expect(() =>
      parseHookProtocolOutput('{"controlPatch":{"decision":"skip"}}', "json"),
    ).toThrow(HookProtocolError);

    expect(() =>
      parseHookProtocolOutput('{"controlPatch":{"stopReason":1}}', "json"),
    ).toThrow(HookProtocolError);

    expect(() =>
      parseHookProtocolOutput('{"controlPatch":{"suppressOutput":"no"}}', "json"),
    ).toThrow(HookProtocolError);

    expect(() =>
      parseHookProtocolOutput('{"controlPatch":{"tags":["ok",1]}}', "json"),
    ).toThrow(HookProtocolError);
  });

  it("rejects non-object json payloads", () => {
    expect(() => parseHookProtocolOutput('["not","object"]', "json")).toThrow(HookProtocolError);
  });

  it("accepts a full valid control patch", () => {
    expect(
      parseHookProtocolOutput(
        '{"controlPatch":{"continue":false,"stopReason":"blocked","suppressOutput":true,"decision":"block","tags":["policy"]}}',
        "json",
      ),
    ).toEqual({
      metadataPatch: undefined,
      sharedPatch: undefined,
      eventDataPatch: undefined,
      contextPatch: undefined,
      modelRequestPatch: undefined,
      modelResponsePatch: undefined,
      toolInvocationPatch: undefined,
      toolResultPatch: undefined,
      observationPatch: undefined,
      permissionsPatch: undefined,
      controlPatch: {
        continue: false,
        stopReason: "blocked",
        suppressOutput: true,
        decision: "block",
        tags: ["policy"],
      },
    });
  });
});
