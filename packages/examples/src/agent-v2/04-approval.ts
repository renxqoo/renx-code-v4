/**
 * 04-approval.ts — Human-in-the-loop approval demo with real LLM
 *
 * Demonstrates:
 *   - withApproval plugin for tool call approval
 *   - `onTools` injection point
 *   - Pause/resume flow via `pause:approval` event
 *
 * The LLM is given tools and the approval plugin intercepts tool calls
 * before execution. In this demo, weather queries are auto-approved,
 * while file operations require manual review (and are denied).
 *
 * Prerequisites: set MINIMAX_API_KEY
 * Run: pnpm demo:agent-v2-approval
 */
import {
  agent, pipe,
  setDefaultLLMClient,
} from "@renx/agent-v2";
import { userMessage } from "@renx/agent-v2";
import { withApproval } from "@renx/agent-v2/plugins";
import { createProviderBridge } from "@renx/agent-v2/providers";
import { createDefaultLLMClient, minimax } from "@renx/provider";
import type { ToolCallInfo } from "@renx/agent-v2";
import { z } from "zod";

// ─── Setup ───
const providerClient = createDefaultLLMClient({ vendors: ["minimax"] });
setDefaultLLMClient(createProviderBridge(providerClient));

// ─── Tools ───
const weatherTool = {
  name: "get_weather",
  description: "Get current weather for a city",
  parameters: z.object({ city: z.string() }),
  async execute(input: { city: string }) {
    return { city: input.city, temperature: 22, condition: "sunny" };
  },
};

const fileTool = {
  name: "read_file",
  description: "Read contents of a file from the filesystem",
  parameters: z.object({ path: z.string() }),
  async execute(input: { path: string }) {
    return { path: input.path, content: "[redacted file contents]" };
  },
};

// ─── Main ───
async function main() {
  const MODEL = minimax("MiniMax-M2.7");
  console.log("=== agent-v2 Approval (Human-in-the-loop) Demo ===\n");
  console.log(`Model: ${MODEL}\n`);

  const approved = pipe(
    withApproval({
      approve: async (toolCalls: ToolCallInfo[]) => {
        console.log(`\n[Approval] ${toolCalls.length} tool call(s) pending:`);
        for (const tc of toolCalls) {
          console.log(`  - ${tc.name}(${JSON.stringify(tc.args)})`);
        }
        // Auto-approve weather tool; deny file operations (simulate manual review)
        const denyIds = toolCalls
          .filter((tc) => tc.name !== "get_weather")
          .map((tc) => tc.id);

        if (denyIds.length > 0) {
          console.log(`  → DENYING: ${denyIds.join(", ")} (requires manual approval)`);
          return { action: "deny", callIds: denyIds, reason: "File operations require manual review" };
        }

        console.log("  → ALLOWING: weather tool will execute");
        return { action: "allow" };
      },
    }),
    agent,
  );

  console.log("Starting agent with approval...\n");

  for await (const event of approved({
    model: MODEL,
    systemPrompt: "You have tools: get_weather (city) and read_file (path). Use them.",
    messages: [userMessage("What's the weather in Beijing and what's in /etc/config?")],
    tools: [weatherTool, fileTool],
    maxSteps: 5,
  })) {
    switch (event.type) {
      case "llm:tool-call":
        console.log(`  [llm:tool-call] ${event.name}(${JSON.stringify(event.arguments)})`);
        break;
      case "tool:start":
        console.log(`  [tool:start]     ${event.name}`);
        break;
      case "tool:result":
        console.log(`  [tool:result]    ${event.callId} ok=${event.ok} duration=${event.durationMs}ms`);
        break;
      case "tool:error":
        console.log(`  [tool:error]    ${event.callId} → ${event.error}`);
        break;
      case "run:finished":
        console.log(`\n  [run:finished] ${event.outcome.finishReason} (${event.outcome.totalSteps} steps)`);
        break;
    }
  }

  console.log("\nApproval demo completed.");
}

main().catch(console.error);
