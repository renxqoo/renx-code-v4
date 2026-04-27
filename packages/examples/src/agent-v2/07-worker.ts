/**
 * 07-worker.ts — Background worker mode demo with real LLM
 *
 * Demonstrates:
 *   - createWorker() for distributed task processing
 *   - Worker polls adapter for pending runs and executes them
 *   - RunManager.create() enqueues runs; Worker picks them up
 *   - Lease-based concurrency control
 *
 * Prerequisites: set MINIMAX_API_KEY
 * Run: pnpm demo:agent-v2-worker
 */
import {
  agent,
  setDefaultLLMClient,
} from "@renx/agent-v2";
import { userMessage } from "@renx/agent-v2";
import { getRunManager, createWorker } from "@renx/agent-v2/runner";
import { InMemoryAdapter } from "@renx/agent-v2/adapters";
import { createProviderBridge } from "@renx/agent-v2/providers";
import { createDefaultLLMClient, minimax } from "@renx/provider";

// ─── Setup ───
const providerClient = createDefaultLLMClient({ vendors: ["minimax"] });
setDefaultLLMClient(createProviderBridge(providerClient));

// ─── Main ───
async function main() {
  const MODEL = minimax("MiniMax-M2.7");
  console.log("=== agent-v2 Worker Demo ===\n");
  console.log(`Model: ${MODEL}\n`);

  const adapter = new InMemoryAdapter();

  const worker = createWorker({
    agent,
    adapter,
    pollIntervalMs: 500,
    batchSize: 10,
    statuses: ["ready"],
    workerId: "demo-worker-1",
    leaseTtlMs: 30000,
  });

  console.log("[Setup] Worker created:");
  console.log("  workerId:      demo-worker-1");
  console.log("  pollInterval:  500ms");
  console.log("  batchSize:     10");
  console.log('  statuses:      ["ready"]');

  // Enqueue tasks via RunManager (status "ready")
  const manager = getRunManager(agent, adapter);
  const tasks = [
    manager.create({
      runId: "task-1", model: MODEL,
      systemPrompt: "You process orders. Respond with 'Order #1001 PROCESSED'.",
      messages: [userMessage("Process order #1001")],
    }),
    manager.create({
      runId: "task-2", model: MODEL,
      systemPrompt: "You process orders. Respond with 'Order #1002 PROCESSED'.",
      messages: [userMessage("Process order #1002")],
    }),
    manager.create({
      runId: "task-3", model: MODEL,
      systemPrompt: "You process orders. Respond with 'Order #1003 PROCESSED'.",
      messages: [userMessage("Process order #1003")],
    }),
  ];

  console.log("\n[Enqueue] Created 3 tasks in 'ready' status:");
  for (const t of tasks) console.log(`  ${t.runId} → status: ${t.status()}`);

  const pending = await adapter.listRuns({ status: "ready" });
  console.log(`\n[Pending] ${pending.length} run(s) waiting`);

  console.log("\n[Worker] Polling for tasks...");
  await worker.poll();

  console.log("\n[Post-poll] Checking run states:");
  for (const t of tasks) {
    const s = await adapter.loadState(t.runId);
    if (s) {
      console.log(`  ${s.runId}: status=${s.status}${s.lockedBy ? ` lockedBy=${s.lockedBy}` : ""}`);
      const evts = await adapter.getEvents(t.runId);
      console.log(`    events: ${evts.length}`);
    }
  }

  worker.stop();
  console.log("\n[Worker] Stopped.");
  console.log("\nIn production, the worker runs continuously with lease renewal.");
  console.log("Multiple workers share a PostgresAdapter for distributed processing.");
}

main().catch(console.error);
