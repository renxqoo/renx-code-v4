/**
 * 09-tool-calling-stream.ts — Tool calling with streaming
 *
 * Demonstrates how streaming handles tool calls:
 * - tool-call-delta chunks arrive during the stream
 * - toolCalls promise resolves to the aggregated list
 * - Text, reasoning, and tool calls can interleave
 *
 * Run:  pnpm demo:tool-calling-stream
 * Env:  OPENAI_API_KEY=sk-...
 */
import { streamText, openai } from "@renx/provider";

async function main() {
  console.log("=== Streaming with Tool Calls ===\n");

  const { textStream, text, reasoning, toolCalls, finishReason } = await streamText({
    model: openai("gpt-4o-mini"),
    prompt: "Search for 'TypeScript 5.0 features' and then summarize the results.",
    tools: [
      {
        name: "web_search",
        description: "Search the web for information",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
          },
          required: ["query"],
        },
      },
    ],
    toolChoice: "auto",
  });

  // Process chunks in real-time
  for await (const chunk of textStream) {
    switch (chunk.type) {
      case "text-delta":
        process.stdout.write(chunk.textDelta);
        break;
      case "reasoning-delta":
        process.stdout.write(`\n[thinking] ${chunk.reasoningDelta}`);
        break;
      case "tool-call-delta":
        if (chunk.name) {
          console.log(`\n[tool-call: ${chunk.name}]`);
        }
        if (chunk.argumentsDelta) {
          process.stdout.write(chunk.argumentsDelta);
        }
        break;
      case "finish":
        // Handled via promises below
        break;
    }
  }

  // Aggregated results
  console.log("\n\n=== Aggregated Results ===");
  console.log(`Full text:     ${await text}`);
  console.log(`Reasoning:     ${await reasoning}`);
  console.log(`Finish reason: ${await finishReason}`);

  const calls = await toolCalls;
  if (calls.length > 0) {
    console.log(`\nTool calls (${calls.length}):`);
    for (const tc of calls) {
      console.log(`  [${tc.id}] ${tc.name}(${tc.arguments})`);
    }
  } else {
    console.log("\nNo tool calls — model responded directly.");
  }
}

main().catch(console.error);
