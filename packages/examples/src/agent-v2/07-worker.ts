/**
 * 07-worker.ts — Background worker mode demo with real LLM
 *
 * Demonstrates:
 *   - createWorker() + poll() (with Postgres, worker acquires runs)
 *   - FileSystemAdapter: acquirePendingRuns() is always empty — worker does not run jobs
 *   - To hit the LLM on disk, this demo explicitly consumes ManagedRun.stream()
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
import { FileSystemAdapter } from "@renx/agent-v2/adapters";
import { createProviderBridge } from "@renx/agent-v2/providers";
import { createDefaultLLMClient, minimax } from "@renx/provider";
import path from "node:path";

// ─── Setup ───
const providerClient = createDefaultLLMClient({ vendors: ["minimax"] });
setDefaultLLMClient(createProviderBridge(providerClient));

// ─── Main ───
async function main() {
  const MODEL = minimax("MiniMax-M2.7");
  console.log("=== agent-v2 Worker Demo ===\n");
  console.log(`Model: ${MODEL}\n`);

  const adapter = new FileSystemAdapter(path.join(process.cwd(), "data"));

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
      runId: "job-1",
      model: MODEL,
      systemPrompt:
        "You are a concise tech editor. Answer in at most 2 sentences, no preamble.",
      messages: [
        userMessage(
          "用一句话解释：HTTP 里 GET 请求为什么应当尽量设计成幂等的？",
        ),
      ],
    }),
    manager.create({
      runId: "job-2",
      model: MODEL,
      systemPrompt:
        "You translate to natural Simplified Chinese. Output only the translation, no quotes.",
      messages: [
        userMessage('Translate: "Fail fast, fix faster."'),
      ],
    }),
    manager.create({
      runId: "job-3",
      model: MODEL,
      systemPrompt:
        'Reply with a single JSON object only, no markdown fence. Schema: {"task":"string","done":boolean}',
      messages: [
        userMessage(
          'Fill task with "worker-demo-check" and done with true.',
        ),
      ],
    }),
  ];

  console.log("\n[Enqueue] Created 3 demo jobs in 'ready' status:");
  for (const t of tasks) console.log(`  ${t.runId} → status: ${t.status()}`);

  const ourRunIds = new Set(tasks.map((t) => t.runId));
  const allReady = await adapter.listRuns({ status: "ready" });
  const readyOurs = allReady.filter((s) => ourRunIds.has(s.runId)).length;
  console.log(
    `\n[Pending] ready runs from this script: ${readyOurs}; all ready under data/: ${allReady.length}`,
  );

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

  console.log(
    "\n[LLM] FileSystem 下 worker 不会领取任务；对每个 job 调用 stream() 走默认 LLM：",
  );
  for (const t of tasks) {
    console.log(`\n--- ${t.runId} (before: ${t.status()}) ---`);
    for await (const ev of t.stream()) {
      if (ev.type === "run:finished") {
        const { outcome } = ev;
        console.log(
          `  finishReason=${outcome.finishReason} tokens in/out=${outcome.tokenUsage.input}/${outcome.tokenUsage.output}`,
        );
        const body = outcome.text?.trim();
        if (body) console.log(`  reply:\n${body}`);
      }
    }
    const persisted = await adapter.loadState(t.runId);
    console.log(`  after (persisted): ${persisted?.status ?? "?"}`);
  }

  console.log("\nIn production, the worker runs continuously with lease renewal.");
  console.log("Multiple workers share a PostgresAdapter for distributed processing.");
}

main().catch(console.error);
