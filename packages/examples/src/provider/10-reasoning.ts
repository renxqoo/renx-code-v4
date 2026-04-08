/**
 * 10-reasoning.ts — Reasoning / thinking content in streams
 *
 * Some providers (e.g. MiniMax with reasoning_split) return
 * reasoning content alongside the main text. The SDK exposes
 * this via `reasoning-delta` chunks and the `reasoning` promise.
 *
 * Run:  pnpm demo:reasoning
 * Env:  MINIMAX_API_KEY=...  (or OPENAI_API_KEY for OpenAI o-series)
 */
import { streamText, minimax } from "@renx/provider";

async function main() {
  console.log("=== Reasoning / Thinking Stream ===\n");

  // MiniMax: reasoning_split enables thinking output
  const { textStream, text, reasoning } = await streamText(
    {
      model: minimax("MiniMax-M2.7"),
      prompt:
        "Solve: If a train travels 120km in 2 hours, then 80km in 1 hour, what's the average speed?",
      temperature: 0.1,
      providerOptions: {
        reasoning_split: true,
      },
    },
    {
      vendors: ["openai", "anthropic", "minimax"],
    },
  );

  // Print chunks as they arrive
  for await (const chunk of textStream) {
    switch (chunk.type) {
      case "text-delta":
        process.stdout.write(chunk.textDelta);
        break;
      case "reasoning-delta":
        // Thinking/reasoning content — shown separately
        process.stdout.write(`\x1b[90m${chunk.reasoningDelta}\x1b[0m`);
        break;
    }
  }

  console.log("\n\n=== Final Results ===");
  console.log(`\nReasoning:\n${await reasoning}`);
  console.log(`\nAnswer:\n${await text}`);
}

main().catch(console.error);
