/**
 * 01-generate-text.ts — Basic text generation
 *
 * Run:  pnpm demo:generate-text
 * Env:  OPENAI_API_KEY=sk-...
 */
import { generateText, openai } from "@renx/provider";

async function main() {
  const result = await generateText({
    model: openai("gpt-4o-mini"),
    prompt: "Explain TypeScript generics in 3 sentences.",
    temperature: 0.7,
  });

  console.log("=== Text ===");
  console.log(result.text);

  console.log("\n=== Usage ===");
  console.log(
    `Input tokens: ${result.usage?.inputTokens ?? "N/A"}, ` +
      `Output tokens: ${result.usage?.outputTokens ?? "N/A"}`,
  );

  console.log("\n=== Finish Reason ===");
  console.log(result.finishReason);
}

main().catch(console.error);
