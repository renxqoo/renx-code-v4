/**
 * 02-stream-text.ts — Streaming text generation
 *
 * Run:  pnpm demo:stream-text
 * Env:  OPENAI_API_KEY=sk-...
 */
import { streamText } from "@renx/provider";
// providerOptions: { minimax: { reasoning_split: true } }
// minimax vendor needs vendors: ["openai", "anthropic", "minimax"] or vendors: ["minimax"]
const clientOptions = {
  vendors: ["openai", "anthropic", "minimax"],
  apiKeys: { minimax: process.env.MINIMAX_API_KEY },
};
// console.log( process.env);
async function main() {
  console.time("streamText");
  const { textStream } = await streamText(
    {
      model: "minimax/MiniMax-M2.7",
      prompt: "你好",
      temperature: 0.1,
      providerOptions: {
        reasoning_split: true,
      },
    },
    clientOptions,
  );
  console.timeEnd("streamText");

  for await (const chunk of textStream) {
    if (chunk.type === "text-delta") {
      process.stdout.write(chunk.textDelta);
    }
    if (chunk.type === "reasoning-delta") {
      console.log(chunk.reasoningDelta);
    }
  }
}

main().catch(console.error);
