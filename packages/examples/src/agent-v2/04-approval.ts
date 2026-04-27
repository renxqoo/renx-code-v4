/**
 * 04-approval.ts — Human-in-the-loop approval demo with real LLM
 *
 * Demonstrates:
 *   - withApproval plugin for tool call approval
 *   - `onTools` injection point
 *   - Interactive confirmation via stdin
 *
 * When the LLM wants to call a tool, you are prompted to approve or
 * deny each tool call in real time.
 *
 * Prerequisites: set MINIMAX_API_KEY
 * Run: pnpm demo:agent-v2-approval
 */
import * as readline from "node:readline";
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

// ─── Interactive prompt ───
function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

// ─── Main ───
async function main() {
  const MODEL = minimax("MiniMax-M2.7");
  console.log("=== agent-v2 Approval (Human-in-the-loop) Demo ===\n");
  console.log(`Model: ${MODEL}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const approved = pipe(
    withApproval({
      approve: async (toolCalls: ToolCallInfo[]) => {
        console.log(`\n───────────────────────────────────────`);
        console.log(` [Approval] ${toolCalls.length} tool call(s) pending:`);
        for (const tc of toolCalls) {
          console.log(`   ${tc.name}(${JSON.stringify(tc.args)})`);
        }
        console.log(`───────────────────────────────────────`);

        const denyIds: string[] = [];
        for (const tc of toolCalls) {
          const answer = await ask(rl, `   Approve "${tc.name}"? [Y/n]: `);
          if (answer.toLowerCase() === "n" || answer.toLowerCase() === "no") {
            denyIds.push(tc.id);
          }
        }

        if (denyIds.length === toolCalls.length) {
          console.log(`   → ALL DENIED\n`);
          return { action: "deny", callIds: denyIds, reason: "User denied all tool calls" };
        }
        if (denyIds.length > 0) {
          console.log(`   → Partially denied: ${denyIds.join(", ")}\n`);
          return { action: "deny", callIds: denyIds, reason: "User denied some tool calls" };
        }
        console.log(`   → ALL APPROVED\n`);
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
      case "llm:delta":
        process.stdout.write(event.delta);
        break;
      case "llm:tool-call":
        console.log(`\n  [llm:tool-call] ${event.name}(${JSON.stringify(event.arguments)})`);
        break;
      case "tool:start":
        console.log(`\n  [tool:start]     ${event.name}`);
        break;
      case "tool:result":
        console.log(`  [tool:result]    ${event.callId} ok=${event.ok} duration=${event.durationMs}ms`);
        break;
      case "tool:error":
        console.log(`  [tool:error]    ${event.callId} → ${event.error}`);
        break;
      case "run:finished":
        console.log(`\n\n══════ Final Result ══════`);
        console.log(event.outcome.text);
        console.log(`═════════════════════════`);
        console.log(`\n  [run:finished] ${event.outcome.finishReason} (${event.outcome.totalSteps} steps)`);
        break;
    }
  }

  rl.close();
  console.log("\nApproval demo completed.");
  console.log("\nFlow: LLM → tool-call → [Y/n] prompt → approve/deny → execute/skip → next step");
}

main().catch(console.error);
