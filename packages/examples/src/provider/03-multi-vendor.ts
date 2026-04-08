/**
 * 03-multi-vendor.ts — Use multiple LLM vendors in one program
 *
 * Run:  pnpm demo:multi-vendor
 * Env:  OPENAI_API_KEY=sk-..., ANTHROPIC_API_KEY=sk-ant-..., MINIMAX_API_KEY=...
 */
import { createDefaultLLMClient, openai, anthropic, minimax } from "@renx/provider";

async function main() {
  // Create a client that supports all three vendors.
  // API keys are read from environment variables by default:
  //   OPENAI_API_KEY, ANTHROPIC_API_KEY, MINIMAX_API_KEY
  const client = createDefaultLLMClient({
    vendors: ["openai", "anthropic", "minimax"],
  });

  const prompt = "Say hello in one sentence.";

  const vendors = [
    { name: "OpenAI", model: openai("gpt-4o-mini") },
    { name: "Anthropic", model: anthropic("claude-sonnet-4-20250514") },
    { name: "MiniMax", model: minimax("MiniMax-M2.7") },
  ] as const;

  for (const { name, model } of vendors) {
    console.log(`\n=== ${name} ===`);
    try {
      const result = await client.generateText({ model, prompt });
      console.log(result.text);
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : e}`);
    }
  }
}

main().catch(console.error);
