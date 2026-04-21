import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { FileSessionStore } from "./file-session-store";
import type { AgentRunRecord, AgentRuntimeEvent } from "./session-store";

const tempDirs: string[] = [];

async function createTempStore(): Promise<{ directory: string; store: FileSessionStore }> {
  const directory = await mkdtemp(join(tmpdir(), "renx-agent-store-"));
  tempDirs.push(directory);
  return {
    directory,
    store: new FileSessionStore({ directory }),
  };
}

function makeRun(runId: string): AgentRunRecord {
  return {
    runId,
    status: "ready",
    maxSteps: 3,
    llmRounds: 0,
    initial: {
      model: "openai/gpt-4o-mini",
      systemPrompt: "Be concise.",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    },
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    createdAt: "2026-04-21T00:00:00.000Z",
    updatedAt: "2026-04-21T00:00:00.000Z",
  };
}

function makeEvents(runId: string): AgentRuntimeEvent[] {
  return [
    {
      type: "run_created",
      runId,
      at: "2026-04-21T00:00:00.000Z",
      model: "openai/gpt-4o-mini",
      maxSteps: 3,
    },
    {
      type: "run_started",
      runId,
      at: "2026-04-21T00:00:01.000Z",
      resumed: false,
      status: "running",
    },
  ];
}

describe("FileSessionStore", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("persists runs and events across store instances", async () => {
    const { directory, store } = await createTempStore();
    const run = makeRun("run-persist");
    const events = makeEvents(run.runId);

    await store.createRun(run);
    await store.appendEvents(run.runId, events);

    const reloaded = new FileSessionStore({ directory });
    expect(await reloaded.getRun(run.runId)).toEqual(run);
    expect(await reloaded.listEvents(run.runId)).toEqual(events);
  });

  it("supports sliced event replay from durable storage", async () => {
    const { store } = await createTempStore();
    const run = makeRun("run-slice");
    const events = [
      ...makeEvents(run.runId),
      {
        type: "run_finished" as const,
        runId: run.runId,
        at: "2026-04-21T00:00:02.000Z",
        status: "finished" as const,
        finishReason: "stop" as const,
      },
    ];

    await store.createRun(run);
    await store.appendEvents(run.runId, events);

    expect(await store.listEvents(run.runId, { offset: 1, limit: 1 })).toEqual(events.slice(1, 2));
  });

  it("persists run listings and leases across store instances", async () => {
    const { directory, store } = await createTempStore();
    const readyRun = makeRun("run-ready");
    const finishedRun = {
      ...makeRun("run-finished"),
      status: "finished" as const,
      finishedAt: "2026-04-21T00:00:05.000Z",
    };

    await store.createRun(readyRun);
    await store.createRun(finishedRun);
    const lease = await store.acquireLease(readyRun.runId, "worker-a", 10_000);

    const reloaded = new FileSessionStore({ directory });
    expect((await reloaded.listRuns({ statuses: ["ready"] })).map((run) => run.runId)).toEqual([readyRun.runId]);
    expect(await reloaded.getLease(readyRun.runId)).toEqual(lease);

    await reloaded.releaseLease(readyRun.runId, "worker-a");
    expect(await reloaded.getLease(readyRun.runId)).toBeNull();
  });
});
