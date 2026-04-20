/**
 * 04-runtime-cancel-run.ts — `cancelRun()` demo
 *
 * 演示：
 * - 创建 run
 * - 取消 run
 * - 查询最终状态
 *
 * Run: pnpm demo:agent-cancel
 */
import { createFakeRuntime, createRuntimeDemoRequest, printRunRecord, printTrace } from "./shared/fake-runtime";

async function run() {
  const { runtime } = createFakeRuntime({
    steps: [{ text: "This response should never be used because the run is cancelled first." }],
  });

  const managedRun = await runtime.createRun(
    createRuntimeDemoRequest("Prepare a cancellation demo."),
  );

  console.log("=== Before cancelRun() ===");
  printRunRecord(await runtime.getRun(managedRun.runId));

  await runtime.cancelRun(managedRun.runId);

  console.log("\n=== After cancelRun() ===");
  printRunRecord(await runtime.getRun(managedRun.runId));

  console.log("\n=== Trace ===");
  printTrace(await runtime.getRunTrace(managedRun.runId));
}

run().catch(console.error);
