/**
 * 03-runtime-resume-permission.ts — 低层 `AgentRuntime.resumeRun()` demo
 *
 * 这个例子使用 fake LLMClient，稳定演示：
 * - `AgentRuntime.createRun()`
 * - `AgentRuntime.startRun()`
 * - `waiting_permission`
 * - `AgentRuntime.resumeRun()`
 *
 * Run: pnpm demo:agent-resume
 */
import { createPermissionHook } from "@renx/agent";
import { createFakeRuntime, createRuntimeDemoRequest, printRunRecord, printTrace } from "./shared/fake-runtime";

async function run() {
  let approved = false;

  const { runtime } = createFakeRuntime({
    steps: [
      {
        toolCalls: [
          {
            id: "call-1",
            name: "send_email",
            arguments:
              '{"to":"ceo@example.com","subject":"Production incident","body":"The incident is mitigated."}',
          },
        ],
      },
      {
        text: "审批通过后，run 已继续执行并完成。",
      },
    ],
    hooks: [
      createPermissionHook({
        toolsRequiringConfirmation: ["send_email"],
        confirm: async () => approved,
        onReject: "pause",
        rejectReason: "Awaiting operator approval.",
      }),
    ],
  });

  const managedRun = await runtime.createRun(
    createRuntimeDemoRequest("Look up the customer and send the final approval email."),
  );

  const paused = await runtime.startRun(managedRun.runId);
  console.log("=== First startRun() ===");
  printRunRecord(await runtime.getRun(managedRun.runId));
  console.log({
    status: paused.status,
    stopReason: paused.stopReason,
    pendingApproval: paused.pendingApproval?.invocations,
  });

  approved = true;
  const resumed = await runtime.resumeRun(managedRun.runId, {
    clearPendingApproval: true,
  });

  console.log("\n=== After resumeRun() ===");
  printRunRecord(await runtime.getRun(managedRun.runId));
  console.log({
    status: resumed.status,
    finishReason: resumed.finishReason,
  });

  console.log("\n=== Trace ===");
  printTrace(await runtime.getRunTrace(managedRun.runId));
}

run().catch(console.error);
