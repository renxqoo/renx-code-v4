import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { HookEngine } from "./hook-engine";
import { HookEventBus } from "./hook-events";
import { HookRegistry } from "./hook-registry";
import { applyHookPatch } from "./hook-patch";
import {
  HookExecutionError,
  HookHttpError,
  HookSerializationError,
  HookValidationError,
  createCallbackHook,
  createCommandHook,
  createHttpHook,
} from "./index";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
    ),
  );
});

function createServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to get server address"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

describe("HookEngine", () => {
  it("runs callback hooks serially and chains patches", async () => {
    const registry = new HookRegistry();
    registry.register(
      createCallbackHook({
        id: "trace",
        name: "trace",
        event: "beforeModelCall",
        run: () => ({
          metadataPatch: { traceId: "t-1" },
          modelRequestPatch: { timeoutMs: 1000 },
        }),
      }),
    );
    registry.register(
      createCallbackHook({
        id: "headers",
        name: "headers",
        event: "beforeModelCall",
        run: (context) => ({
          modelRequestPatch: {
            headers: { "x-trace-id": String(context.metadata?.traceId) },
          },
        }),
      }),
    );

    const engine = new HookEngine({ registry });
    const result = await engine.execute("beforeModelCall", {
      metadata: {},
      modelRequest: {},
    });

    expect(result.executedHooks).toEqual(["trace", "headers"]);
    expect(result.context.metadata).toEqual({ traceId: "t-1" });
    expect(result.context.modelRequest).toEqual({
      timeoutMs: 1000,
      headers: { "x-trace-id": "t-1" },
    });
  });

  it("matches hooks by conditions and scope", async () => {
    const registry = new HookRegistry();
    registry.register(
      createCallbackHook({
        id: "global-shell",
        name: "global-shell",
        event: "beforeToolExecution",
        when: [{ path: "toolInvocation.toolName", operator: "equals", value: "shell" }],
        run: () => ({ metadataPatch: { matched: "global" } }),
      }),
    );
    registry.register(
      createCallbackHook({
        id: "session-shell",
        name: "session-shell",
        event: "beforeToolExecution",
        scope: { kind: "session", sessionId: "s1" },
        run: () => ({ metadataPatch: { scoped: true } }),
      }),
    );

    const engine = new HookEngine({ registry });
    const result = await engine.execute(
      "beforeToolExecution",
      {
        metadata: {},
        toolInvocation: { toolName: "shell" },
      },
      { scope: { kind: "session", sessionId: "s1" } },
    );

    expect(result.executedHooks).toEqual(["global-shell", "session-shell"]);
    expect(result.context.metadata).toEqual({ matched: "global", scoped: true });
  });

  it("stops serial execution when a hook blocks continuation", async () => {
    const registry = new HookRegistry();
    registry.register(
      createCallbackHook({
        id: "blocker",
        name: "blocker",
        event: "afterToolExecution",
        run: () => ({
          controlPatch: {
            continue: false,
            stopReason: "policy blocked continuation",
          },
        }),
      }),
    );
    registry.register(
      createCallbackHook({
        id: "should-not-run",
        name: "should-not-run",
        event: "afterToolExecution",
        run: () => ({
          metadataPatch: { unreachable: true },
        }),
      }),
    );

    const engine = new HookEngine({ registry });
    const result = await engine.execute("afterToolExecution", {});

    expect(result.executedHooks).toEqual(["blocker"]);
    expect(result.stopped).toBe(true);
    expect(result.stopReason).toBe("policy blocked continuation");
  });

  it("throws on critical hook failures", async () => {
    const registry = new HookRegistry();
    registry.register(
      createCallbackHook({
        id: "critical",
        name: "critical",
        event: "beforeRun",
        critical: true,
        run: () => {
          throw new Error("boom");
        },
      }),
    );

    const engine = new HookEngine({ registry });
    await expect(engine.execute("beforeRun", {})).rejects.toBeInstanceOf(HookExecutionError);
  });

  it("executes command hooks and parses JSON patches from stdout", async () => {
    const registry = new HookRegistry();
    registry.register(
      createCommandHook({
        id: "command",
        name: "command",
        event: "beforeModelCall",
        command: process.execPath,
        args: [
          "-e",
          [
            "process.stdin.setEncoding('utf8');",
            "let data='';",
            "process.stdin.on('data', c => data += c);",
            "process.stdin.on('end', () => {",
            "  const input = JSON.parse(data);",
            "  process.stdout.write(JSON.stringify({ metadataPatch: { fromCommand: true }, modelRequestPatch: { seenEvent: input.event } }));",
            "});",
          ].join(" "),
        ],
      }),
    );

    const engine = new HookEngine({ registry });
    const result = await engine.execute("beforeModelCall", {
      metadata: {},
      modelRequest: {},
    });

    expect(result.context.metadata).toEqual({ fromCommand: true });
    expect(result.context.modelRequest).toEqual({ seenEvent: "beforeModelCall" });
  });

  it("executes http hooks and parses JSON response patches", async () => {
    const url = await createServer(async (req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as { event: string };
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            observationPatch: { source: "http" },
            metadataPatch: { echoedEvent: parsed.event },
          }),
        );
      });
    });

    const registry = new HookRegistry();
    registry.register(
      createHttpHook({
        id: "http",
        name: "http",
        event: "afterModelCall",
        url,
      }),
    );

    const engine = new HookEngine({ registry });
    const result = await engine.execute("afterModelCall", {
      metadata: {},
      observation: {},
    });

    expect(result.context.metadata).toEqual({ echoedEvent: "afterModelCall" });
    expect(result.context.observation).toEqual({ source: "http" });
  });

  it("treats non-zero command exit as an execution error", async () => {
    const registry = new HookRegistry();
    registry.register(
      createCommandHook({
        id: "command-error",
        name: "command-error",
        event: "beforeModelCall",
        command: process.execPath,
        args: ["-e", "process.stderr.write('bad'); process.exit(12);"],
      }),
    );

    const engine = new HookEngine({ registry });
    const result = await engine.execute("beforeModelCall", {});

    expect(result.invocations).toHaveLength(1);
    expect(result.invocations[0]?.status).toBe("error");
    expect(result.issues[0]?.error).toBeInstanceOf(Error);
  });

  it("treats non-2xx http responses as an execution error", async () => {
    const url = await createServer((_req, res) => {
      res.statusCode = 403;
      res.end("forbidden");
    });

    const registry = new HookRegistry();
    registry.register(
      createHttpHook({
        id: "http-error",
        name: "http-error",
        event: "afterModelCall",
        url,
      }),
    );

    const engine = new HookEngine({ registry });
    const result = await engine.execute("afterModelCall", {});

    expect(result.invocations).toHaveLength(1);
    expect(result.invocations[0]?.status).toBe("error");
    expect(result.issues[0]?.error).toBeInstanceOf(HookHttpError);
  });

  it("emits hook lifecycle events including progress", async () => {
    const registry = new HookRegistry();
    registry.register(
      createCommandHook({
        id: "progress",
        name: "progress",
        event: "beforeStep",
        command: process.execPath,
        args: [
          "-e",
          [
            "process.stdout.write('hello');",
            "process.stdout.write(JSON.stringify({ metadataPatch: { ok: true } }));",
          ].join(" "),
        ],
      }),
    );

    const bus = new HookEventBus();
    const events: string[] = [];
    bus.subscribe((event) => {
      events.push(event.type);
    });

    const engine = new HookEngine({ registry, events: bus });
    await engine.execute("beforeStep", { metadata: {} });

    expect(events).toContain("started");
    expect(events).toContain("progress");
    expect(events).toContain("completed");
  });

  it("supports parallel execution with deterministic patch merge", async () => {
    const registry = new HookRegistry();
    registry.register(
      createCallbackHook({
        id: "first",
        name: "first",
        event: "beforeBuildContext",
        order: 10,
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { metadataPatch: { a: 1 } };
        },
      }),
    );
    registry.register(
      createCallbackHook({
        id: "second",
        name: "second",
        event: "beforeBuildContext",
        order: 20,
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { metadataPatch: { b: 2 } };
        },
      }),
    );

    const engine = new HookEngine({ registry });
    const result = await engine.execute(
      "beforeBuildContext",
      { metadata: {} },
      { mode: "parallel" },
    );

    expect(result.context.metadata).toEqual({ a: 1, b: 2 });
  });

  it("validates hook definitions at registration time", () => {
    const registry = new HookRegistry();

    expect(() =>
      registry.register(
        createHttpHook({
          id: "bad-http",
          name: "bad-http",
          event: "beforeRun",
          url: "not-a-url",
        }),
      ),
    ).toThrow(HookValidationError);
  });

  it("can fail fast for any hook error when engine defaults require it", async () => {
    const registry = new HookRegistry();
    registry.register(
      createCommandHook({
        id: "strict-failure",
        name: "strict-failure",
        event: "beforeModelCall",
        command: process.execPath,
        args: ["-e", "process.exit(1)"],
      }),
    );

    const engine = new HookEngine({
      registry,
      defaults: { failOnError: true },
    });

    await expect(engine.execute("beforeModelCall", {})).rejects.toBeInstanceOf(HookExecutionError);
  });

  it("continues execution when stopOnBlock is disabled", async () => {
    const registry = new HookRegistry();
    registry.register(
      createCallbackHook({
        id: "blocker",
        name: "blocker",
        event: "afterToolExecution",
        run: () => ({
          controlPatch: { continue: false, stopReason: "blocked" },
        }),
      }),
    );
    registry.register(
      createCallbackHook({
        id: "after-block",
        name: "after-block",
        event: "afterToolExecution",
        run: () => ({
          metadataPatch: { stillRan: true },
        }),
      }),
    );

    const engine = new HookEngine({ registry });
    const result = await engine.execute("afterToolExecution", {}, { stopOnBlock: false });

    expect(result.executedHooks).toEqual(["blocker", "after-block"]);
    expect(result.context.metadata).toEqual({ stillRan: true });
    expect(result.stopped).toBe(true);
  });

  it("applies source and tag filters at execution time", async () => {
    const registry = new HookRegistry();
    registry.register(
      createCallbackHook({
        id: "core-policy",
        name: "core-policy",
        event: "beforeRun",
        source: "core",
        tags: ["policy", "audit"],
        run: () => ({ metadataPatch: { core: true } }),
      }),
    );
    registry.register(
      createCallbackHook({
        id: "plugin-policy",
        name: "plugin-policy",
        event: "beforeRun",
        source: "plugin",
        tags: ["policy"],
        run: () => ({ metadataPatch: { plugin: true } }),
      }),
    );

    const engine = new HookEngine({ registry });
    const result = await engine.execute(
      "beforeRun",
      { metadata: {} },
      { sourceFilter: ["core"], tagFilter: ["policy", "audit"] },
    );

    expect(result.executedHooks).toEqual(["core-policy"]);
    expect(result.context.metadata).toEqual({ core: true });
  });

  it("skips disabled hooks and hooks whose async matcher returns false", async () => {
    const registry = new HookRegistry();
    registry.register(
      createCallbackHook({
        id: "disabled",
        name: "disabled",
        event: "beforeRun",
        enabled: false,
        run: () => ({ metadataPatch: { disabled: true } }),
      }),
    );
    registry.register(
      createCallbackHook({
        id: "rejected",
        name: "rejected",
        event: "beforeRun",
        matches: async () => false,
        run: () => ({ metadataPatch: { rejected: true } }),
      }),
    );
    registry.register(
      createCallbackHook({
        id: "accepted",
        name: "accepted",
        event: "beforeRun",
        matches: async () => true,
        run: () => ({ metadataPatch: { accepted: true } }),
      }),
    );

    const engine = new HookEngine({ registry });
    const result = await engine.execute("beforeRun", { metadata: {} });

    expect(result.matchedHooks).toEqual(["accepted"]);
    expect(result.executedHooks).toEqual(["accepted"]);
    expect(result.context.metadata).toEqual({ accepted: true });
  });

  it("uses engine default timeout and marks a slow hook as timed out", async () => {
    const registry = new HookRegistry();
    registry.register(
      createCallbackHook({
        id: "slow",
        name: "slow",
        event: "beforeRun",
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return { metadataPatch: { late: true } };
        },
      }),
    );

    const engine = new HookEngine({
      registry,
      defaults: { timeoutMs: 5 },
    });

    const result = await engine.execute("beforeRun", {});

    expect(result.invocations[0]?.status).toBe("timed_out");
    expect(result.issues).toHaveLength(1);
    expect(result.executedHooks).toEqual([]);
  });

  it("cancels callback hooks via AbortSignal even without timeout", async () => {
    const registry = new HookRegistry();
    registry.register(
      createCallbackHook({
        id: "wait",
        name: "wait",
        event: "beforeRun",
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { metadataPatch: { done: true } };
        },
      }),
    );

    const controller = new AbortController();
    const bus = new HookEventBus();
    const events: string[] = [];
    bus.subscribe((event) => {
      events.push(event.type);
    });

    const execution = new HookEngine({ registry, events: bus }).execute(
      "beforeRun",
      {},
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 5);

    const result = await execution;
    expect(result.invocations[0]?.status).toBe("cancelled");
    expect(events).toContain("cancelled");
  });

  it("cancels command hooks via AbortSignal", async () => {
    const registry = new HookRegistry();
    registry.register(
      createCommandHook({
        id: "sleep",
        name: "sleep",
        event: "beforeRun",
        command: process.execPath,
        args: ["-e", "setTimeout(() => process.stdout.write('late'), 1000)"],
      }),
    );

    const controller = new AbortController();
    const execution = new HookEngine({ registry }).execute("beforeRun", {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);

    const result = await execution;
    expect(result.invocations[0]?.status).toBe("cancelled");
  });

  it("supports text response mode without trying to parse stdout as patch", async () => {
    const registry = new HookRegistry();
    registry.register(
      createCommandHook({
        id: "text",
        name: "text",
        event: "beforeStep",
        command: process.execPath,
        responseMode: "text",
        args: ["-e", "process.stdout.write('plain text output')"],
      }),
    );

    const result = await new HookEngine({ registry }).execute("beforeStep", { metadata: {} });

    expect(result.invocations[0]?.status).toBe("success");
    expect(result.invocations[0]?.patch).toBeUndefined();
    expect(result.context.metadata).toEqual({});
  });

  it("surfaces serialization errors for non-json-safe command hook input", async () => {
    const registry = new HookRegistry();
    registry.register(
      createCommandHook({
        id: "serialize",
        name: "serialize",
        event: "beforeRun",
        command: process.execPath,
        args: ["-e", "process.stdout.write('ok')"],
      }),
    );

    const result = await new HookEngine({ registry }).execute("beforeRun", {
      metadata: { bad: BigInt(1) },
    });

    expect(result.invocations[0]?.status).toBe("error");
    expect(result.issues[0]?.error).toBeInstanceOf(HookSerializationError);
  });

  it("throws in parallel mode when failOnError is enabled", async () => {
    const registry = new HookRegistry();
    registry.register(
      createCallbackHook({
        id: "ok",
        name: "ok",
        event: "beforeBuildContext",
        order: 10,
        run: () => ({ metadataPatch: { ok: true } }),
      }),
    );
    registry.register(
      createCallbackHook({
        id: "boom",
        name: "boom",
        event: "beforeBuildContext",
        order: 20,
        run: () => {
          throw new Error("parallel boom");
        },
      }),
    );

    const engine = new HookEngine({ registry });
    await expect(
      engine.execute("beforeBuildContext", {}, { mode: "parallel", failOnError: true }),
    ).rejects.toBeInstanceOf(HookExecutionError);
  });

  it("applyHookPatch deep-merges buckets without mutating the original context", () => {
    const original = {
      event: "beforeFinish" as const,
      metadata: { nested: { a: 1 } },
      control: { tags: ["one"] },
    };

    const next = applyHookPatch(original, {
      metadataPatch: { nested: { b: 2 } },
      controlPatch: { tags: ["two"] },
    });

    expect(next).toEqual({
      event: "beforeFinish",
      metadata: { nested: { a: 1, b: 2 } },
      control: { tags: ["one", "two"] },
    });
    expect(original).toEqual({
      event: "beforeFinish",
      metadata: { nested: { a: 1 } },
      control: { tags: ["one"] },
    });
  });
});
