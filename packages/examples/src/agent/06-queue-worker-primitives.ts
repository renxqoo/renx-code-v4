/**
 * 06-queue-worker-primitives.ts — 纯底层后台运行原语 demo
 *
 * 不内置 HTTP / RPC / Web 框架。
 * 只演示：
 * - 上层创建 run
 * - 上层把 runId 入队
 * - worker 后台消费
 * - 上层查询状态 / trace
 * - 上层批准后重新入队
 *
 * Run: pnpm demo:agent-server
 */
import type { AgentRunRecord } from "@renx/agent";
import { BackgroundAgentService } from "./server/background-service";

async function waitForStatus(
  service: BackgroundAgentService,
  runId: string,
  terminalStatuses: string[],
): Promise<AgentRunRecord> {
  while (true) {
    const run = await service.getRun(runId);
    console.log("poll:", {
      runId,
      status: run?.status,
      llmRounds: run?.llmRounds,
    });
    if (run && terminalStatuses.includes(run.status)) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function run() {
  const service = new BackgroundAgentService();
  const workerAbort = new AbortController();
  const workerTask = service.runWorkerLoop(workerAbort.signal);

  try {
    console.log("=== Pure queue / worker primitives ===");

    const approvalRun = await service.createRun({
      prompt: "approval: send the incident-resolved email after approval",
    });

    const lookupRun = await service.createRun({
      prompt: "lookup the customer and summarize the result",
    });

    console.log("\n=== Created runs ===");
    console.log({
      approvalRun: approvalRun.runId,
      lookupRun: lookupRun.runId,
      queuedJobs: service.queue.size(),
    });

    const approvalWaiting = await waitForStatus(service, approvalRun.runId, [
      "waiting_permission",
      "finished",
      "failed",
      "cancelled",
    ]);

    console.log("\n=== Approval run reached waiting state ===");
    console.log({
      runId: approvalWaiting.runId,
      status: approvalWaiting.status,
      pendingApproval: approvalWaiting.pendingApproval?.invocations.map((invocation) => invocation.name),
    });

    if (approvalWaiting.status === "waiting_permission") {
      console.log("\n=== Upper layer approves and re-enqueues ===");
      await service.approveAndResume(approvalRun.runId);
      console.log({ queuedJobs: service.queue.size() });
    }

    const [approvalFinal, lookupFinal] = await Promise.all([
      waitForStatus(service, approvalRun.runId, ["finished", "failed", "cancelled"]),
      waitForStatus(service, lookupRun.runId, ["finished", "failed", "cancelled"]),
    ]);

    const approvalTrace = await service.getTrace(approvalRun.runId);

    console.log("\n=== Final run states ===");
    console.log({
      approval: {
        runId: approvalFinal.runId,
        status: approvalFinal.status,
        llmRounds: approvalFinal.llmRounds,
      },
      lookup: {
        runId: lookupFinal.runId,
        status: lookupFinal.status,
        llmRounds: lookupFinal.llmRounds,
      },
    });

    console.log("\n=== Approval trace types ===");
    console.log(approvalTrace.map((event) => event.type));
  } finally {
    workerAbort.abort();
    await workerTask;
  }
}

run().catch(console.error);
