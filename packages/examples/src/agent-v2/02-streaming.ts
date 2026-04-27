/**
 * 02-streaming.ts — Streaming text output with agent-v2 + real LLM
 *
 * Demonstrates:
 *   - Real-time token streaming via `llm:delta` events
 *   - Token counting and finish reason tracking
 *   - Multi-step responses (when LLM responds multiple times)
 *
 * Prerequisites: set MINIMAX_API_KEY
 * Run: pnpm demo:agent-v2-streaming
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
  console.log("=== agent-v2 Streaming Demo ===\n");
  console.log(`Model: ${MODEL}\n`);

  const gen = agent({
    model: MODEL,
    systemPrompt: "You are a thoughtful assistant. Always think step by step.",
    messages: [userMessage("你好")],
    maxSteps: 3,
  });

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for await (const event of gen) {
    switch (event.type) {
      case "step:started": {
        console.log(`\n── Step ${event.step} ──`);
        break;
      }
      case "llm:delta": {
        process.stdout.write(event.delta);
        break;
      }
      case "llm:done": {
        console.log(`\n[llm:done] finishReason=${event.finishReason}`);
        totalInputTokens += event.usage.input;
        totalOutputTokens += event.usage.output;
        break;
      }
      case "step:completed": {
        console.log(`[step:completed] step=${event.step} finishReason=${event.finishReason}`);
        break;
      }
      case "run:finished": {
        console.log(`\n── Run Complete ──`);
        console.log(`  finishReason:  ${event.outcome.finishReason}`);
        console.log(`  totalSteps:    ${event.outcome.totalSteps}`);
        console.log(`  input tokens:  ${event.outcome.tokenUsage.input}`);
        console.log(`  output tokens: ${event.outcome.tokenUsage.output}`);
        const preview = event.outcome.text.length > 120
          ? event.outcome.text.substring(0, 120) + "..."
          : event.outcome.text;
        console.log(`  full text:     "${preview}"`);
        break;
      }
    }
  }

  console.log("\nStreaming demo finished.");
}

main().catch(console.error);
