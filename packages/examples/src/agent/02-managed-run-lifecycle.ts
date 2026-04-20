/**
 * 02-managed-run-lifecycle.ts — 高层托管生命周期 demo
 *
 * 演示：
 * - `Agent.createRun()`
 * - `Agent.startRun()`
 * - `Agent.getRun()`
 * - `Agent.getRunTrace()`
 *
 * Run: pnpm demo:agent-lifecycle
 */
import { buildRealDemoRequest, createRealDemoAgent, printStreamChunk, requireRealAgentEnv } from "./shared/real-demo";

async function run() {
  const { useOpenRouter } = requireRealAgentEnv();
  const agent = createRealDemoAgent({
    useOpenRouter,
    confirmationMode: "always-allow",
  });

  console.log("=== Agent.createRun / startRun / getRun / getRunTrace ===\n");

  const managedRun = await agent.createRun(buildRealDemoRequest(useOpenRouter));
  console.log("Created run:", { runId: managedRun.runId, status: managedRun.status });

  const out = await agent.startRun(managedRun.runId, {
    onStreamChunk: printStreamChunk,
  });

  const current = await agent.getRun(managedRun.runId);
  const trace = await agent.getRunTrace(managedRun.runId);

  console.log("\n--- Runtime Outcome ---");
  console.log({
    runId: out.runId,
    status: out.status,
    finishReason: out.finishReason,
    summaryId: out.summary?.summaryId,
  });

  console.log("\n--- Stored Run ---");
  console.log({
    runId: current?.runId,
    status: current?.status,
    llmRounds: current?.llmRounds,
    summaryId: current?.summary?.summaryId,
  });

  console.log("\n--- Trace Events ---");
  console.log(trace.map((event) => event.type));
}

run().catch(console.error);
