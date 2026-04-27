/**
 * 01-basic.ts — Minimal agent-v2 usage with real LLM via @renx/provider
 *
 * Demonstrates the core `agent()` async generator:
 *   - Creating an AgentInput
 *   - Streaming events via for-await
 *   - Extracting the final result from `run:finished`
 *
 * Prerequisites: set MINIMAX_API_KEY
 * Run: pnpm demo:agent-v2-basic
 */
import { agent, setDefaultLLMClient } from "@renx/agent-v2";
import { userMessage } from "@renx/agent-v2";
import { createProviderBridge } from "@renx/agent-v2/providers";
import { createDefaultLLMClient, minimax } from "@renx/provider";

// ─── Setup ───
const providerClient = createDefaultLLMClient({ vendors: ["minimax"] });
setDefaultLLMClient(createProviderBridge(providerClient));

// ─── Main ───
async function main() {
  const MODEL = minimax("MiniMax-M2.7");
  console.log("=== agent-v2 Basic Demo ===\n");
  console.log(`Model: ${MODEL}\n`);

  const gen = agent({
    model: MODEL,
    systemPrompt: "You are a helpful assistant. Keep responses brief.",
    messages: [userMessage("Hi, who are you?")],
  });

  console.log("Streaming events:\n");

  for await (const event of gen) {
    switch (event.type) {
      case "run:started":
        console.log(`  [${event.type}] runId=${event.runId} model=${event.model}`);
        break;
      case "step:started":
        console.log(`  [${event.type}] step ${event.step}`);
        break;
      case "llm:delta":
        process.stdout.write(event.delta);
        break;
      case "llm:done":
        console.log(`\n  [${event.type}] finishReason=${event.finishReason} tokens={in:${event.usage.input},out:${event.usage.output}}`);
        break;
      case "step:completed":
        console.log(`  [${event.type}] step ${event.step} tokens={in:${event.tokenUsage.input},out:${event.tokenUsage.output}}`);
        break;
      case "run:finished":
        console.log(`\n  [${event.type}] finishReason=${event.outcome.finishReason} totalSteps=${event.outcome.totalSteps}`);
        console.log(`\n  Final text: "${event.outcome.text}"`);
        break;
      default:
        console.log(`  [${event.type}]`);
    }
  }

  console.log("\nDone.");
}

main().catch(console.error);
