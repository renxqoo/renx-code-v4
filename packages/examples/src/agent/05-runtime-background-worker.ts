/**
 * 05-runtime-background-worker.ts — 后台 worker 模式 demo
 *
 * 这个例子用 in-memory queue + fake runtime 模拟：
 * - API 创建 run
 * - Worker 后台消费 queue
 * - 前端轮询 `getRun()`
 *
 * Run: pnpm demo:agent-worker
 */
import { createFakeRuntime, createRuntimeDemoRequest } from "./shared/fake-runtime";

type JobQueue = string[];

async function processQueue(queue: JobQueue, runtime: ReturnType<typeof createFakeRuntime>["runtime"]) {
  while (queue.length > 0) {
    const runId = queue.shift();
    if (!runId) continue;

    const run = await runtime.getRun(runId);
    if (!run) continue;

    if (run.status === "ready") {
      await runtime.startRun(runId);
      continue;
    }

    if (run.status === "waiting_permission" || run.status === "waiting_input") {
      console.log(`Worker skipped ${runId}: waiting for external input.`);
    }
  }
}

async function pollRun(
  runtime: ReturnType<typeof createFakeRuntime>["runtime"],
  runId: string,
): Promise<void> {
  while (true) {
    const run = await runtime.getRun(runId);
    console.log("frontend poll:", {
      runId,
      status: run?.status,
      llmRounds: run?.llmRounds,
    });
    if (!run || run.status === "finished" || run.status === "failed" || run.status === "cancelled") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function run() {
  const { runtime } = createFakeRuntime({
    steps: [
      { text: "Background worker completed task A.", delayMs: 150 },
      { text: "Background worker completed task B.", delayMs: 150 },
    ],
  });

  const queue: JobQueue = [];

  const runA = await runtime.createRun(createRuntimeDemoRequest("Complete task A in the background."));
  const runB = await runtime.createRun(createRuntimeDemoRequest("Complete task B in the background."));
  queue.push(runA.runId, runB.runId);

  console.log("=== API created runs and enqueued jobs ===");
  console.log(queue);

  await Promise.all([
    processQueue(queue, runtime),
    pollRun(runtime, runA.runId),
    pollRun(runtime, runB.runId),
  ]);

  console.log("\n=== Final states ===");
  console.log(await runtime.getRun(runA.runId));
  console.log(await runtime.getRun(runB.runId));
}

run().catch(console.error);
