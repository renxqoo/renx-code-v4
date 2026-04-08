/**
 * 08-tool-calling.ts — Tool calling (non-stream)
 *
 * Demonstrates how to define tools, call generateText with tools,
 * handle tool_calls in the response, and send tool results back
 * for multi-turn tool use.
 *
 * Run:  pnpm demo:tool-calling
 * Env:  OPENAI_API_KEY=sk-...
 */
import { generateText, openai, type CanonicalMessage } from "@renx/provider";

// Define tools the model can call
const tools = [
  {
    name: "get_weather",
    description: "Get the current weather in a given city",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name" },
      },
      required: ["city"],
    },
  },
  {
    name: "get_time",
    description: "Get the current time in a timezone",
    parameters: {
      type: "object",
      properties: {
        timezone: { type: "string", description: "IANA timezone, e.g. Asia/Shanghai" },
      },
      required: ["timezone"],
    },
  },
];

// Simulate tool execution
function executeTool(name: string, args: Record<string, unknown>): string {
  if (name === "get_weather") {
    return `${args.city}: 25°C, sunny`;
  }
  if (name === "get_time") {
    return new Date().toLocaleString("en-US", { timeZone: args.timezone as string });
  }
  return "Unknown tool";
}

async function main() {
  // --- Step 1: Initial request with tools ---
  console.log("=== Step 1: Send prompt with tools ===\n");

  const messages: CanonicalMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: "What's the weather in Beijing and what time is it there?" }],
    },
  ];

  const r1 = await generateText({
    model: openai("gpt-4o-mini"),
    messages,
    tools,
    toolChoice: "auto",
  });

  console.log(`Finish reason: ${r1.finishReason}`);
  console.log(`Text: ${r1.text || "(empty — model chose tools)"}`);

  if (r1.toolCalls && r1.toolCalls.length > 0) {
    console.log(`\nTool calls (${r1.toolCalls.length}):`);
    for (const tc of r1.toolCalls) {
      console.log(`  [${tc.id}] ${tc.name}(${tc.arguments})`);
    }

    // --- Step 2: Execute tools and send results back ---
    console.log("\n=== Step 2: Send tool results back ===\n");

    // Add assistant's tool_calls to conversation
    messages.push({
      role: "assistant",
      content: r1.toolCalls.map((tc) => ({
        type: "tool_call" as const,
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      })),
    });

    // Add each tool result
    for (const tc of r1.toolCalls) {
      const args = JSON.parse(tc.arguments) as Record<string, unknown>;
      const result = executeTool(tc.name, args);
      console.log(`  Tool ${tc.name} → ${result}`);

      messages.push({
        role: "tool",
        content: [{ type: "tool_result", toolCallId: tc.id, content: result }],
      });
    }

    // --- Step 3: Get final response ---
    console.log("\n=== Step 3: Final response ===\n");

    const r2 = await generateText({
      model: openai("gpt-4o-mini"),
      messages,
      tools,
    });

    console.log(`Finish reason: ${r2.finishReason}`);
    console.log(`Response: ${r2.text}`);
  }
}

main().catch(console.error);
