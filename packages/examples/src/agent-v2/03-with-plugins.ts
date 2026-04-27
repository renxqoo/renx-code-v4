/**
 * 03-with-plugins.ts — Plugin composition demo with real LLM
 *
 * Demonstrates:
 *   - pipe() composition of multiple plugins
 *   - withLogging, withTimeout, withRetry
 *   - Plugin left-to-right wrapping order
 *
 * Prerequisites: set MINIMAX_API_KEY
 * Run: pnpm demo:agent-v2-plugins
 */
import {
  agent, pipe,
  setDefaultLLMClient,
} from "@renx/agent-v2";
import { userMessage } from "@renx/agent-v2";
import { withLogging, withTimeout, withRetry } from "@renx/agent-v2/plugins";
import { createProviderBridge } from "@renx/agent-v2/providers";
import { createDefaultLLMClient, minimax } from "@renx/provider";
import type { Logger } from "@renx/agent-v2/plugins";

// ─── Setup ───
const providerClient = createDefaultLLMClient({ vendors: ["minimax"] });
setDefaultLLMClient(createProviderBridge(providerClient));

// ─── Console Logger ───
const logger: Logger = {
  debug(msg: string, _meta?: Record<string, unknown>) { console.log(`  [DEBUG] ${msg}`); },
  info(msg: string, _meta?: Record<string, unknown>) { console.log(`  [INFO]  ${msg}`); },
  warn(msg: string, _meta?: Record<string, unknown>) { console.log(`  [WARN]  ${msg}`); },
  error(msg: string, _meta?: Record<string, unknown>) { console.log(`  [ERROR] ${msg}`); },
};

// ─── Pipe order explanation ───
//
// pipe(withTimeout(...), withRetry(...), withLogging(...), agent)
//
// Execution order (left-to-right wrapping):
//   request → withTimeout → withRetry → withLogging → agent → events
//   1. withTimeout wraps outermost — cancels if total run exceeds timeout
//   2. withRetry wraps next — retries on retryable LLM errors
//   3. withLogging wraps innermost — logs agent lifecycle events
//   4. agent is the core — actual ReAct loop

async function main() {
  const MODEL = minimax("MiniMax-M2.7");
  console.log("=== agent-v2 Plugin Composition Demo ===\n");
  console.log(`Model: ${MODEL}`);
  console.log("Pipe order: withTimeout → withRetry → withLogging → agent\n");

  const composed = pipe(
    withTimeout({ durationMs: 30_000 }),
    withRetry({ maxRetries: 2 }),
    withLogging({ logger, includeDelta: false }),
    agent,
  );

  console.log("Starting composed agent...\n");

  for await (const event of composed({
    model: MODEL,
    systemPrompt: "You are a helpful assistant. Keep it brief.",
    messages: [userMessage("Greet me in one sentence!")],
  })) {
    if (event.type === "run:finished") {
      console.log(`\n  Final: "${event.outcome.text}" (${event.outcome.totalSteps} steps, ${event.outcome.finishReason})`);
    }
  }

  console.log("\nDone. Plugin effects visible in [INFO]/[DEBUG] logs above.");
}

main().catch(console.error);
