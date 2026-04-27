/**
 * 06-handoff.ts — Agent handoff demo with real LLM
 *
 * Demonstrates:
 *   - handoff() tool factory — creates a tool that triggers agent handoff
 *   - HandoffSignal flow: tool throws → agent catches → yields `handoff` event
 *   - `run:finished` with handoff outcome info
 *
 * The LLM is given handoff tools and decides when to hand off.
 *
 * Prerequisites: set MINIMAX_API_KEY
 * Run: pnpm demo:agent-v2-handoff
 */
import {
  agent,
  setDefaultLLMClient,
} from "@renx/agent-v2";
import { userMessage } from "@renx/agent-v2";
import { handoff } from "@renx/agent-v2/multi-agent";
import { createProviderBridge } from "@renx/agent-v2/providers";
import { createDefaultLLMClient, minimax } from "@renx/provider";

// ─── Setup ───
const providerClient = createDefaultLLMClient({ vendors: ["minimax"] });
setDefaultLLMClient(createProviderBridge(providerClient));

// ─── Create handoff tools ───
const handoffToAnalyst = handoff({
  to: "analyst-agent",
  description: "Transfer the conversation to the analyst agent for data analysis. Use this when the request involves analyzing data or complex computation.",
});

const handoffToSupport = handoff({
  to: "support-agent",
  name: "transfer_to_support",
  description: "Transfer to customer support agent. Use this when the user has a customer service issue.",
});

// ─── Main ───
async function main() {
  const MODEL = minimax("MiniMax-M2.7");
  console.log("=== agent-v2 Handoff Demo ===\n");
  console.log(`Model: ${MODEL}`);
  console.log("The agent has access to handoff tools:");
  console.log("  - handoff_to_analyst_agent → transfers to analyst-agent");
  console.log("  - transfer_to_support → transfers to support-agent\n");

  console.log("Events:\n");

  for await (const event of agent({
    model: MODEL,
    systemPrompt:
      "You are a router agent. You have two handoff options:\n" +
      "1. 'handoff_to_analyst_agent' — for data analysis or research requests\n" +
      "2. 'transfer_to_support' — for customer service issues\n" +
      "If the user's request clearly fits one of these categories, hand off immediately.\n" +
      "Otherwise, answer directly.",
    messages: [userMessage("I need complex data analysis on this dataset.")],
    tools: [handoffToAnalyst, handoffToSupport],
    maxSteps: 5,
  })) {
    switch (event.type) {
      case "llm:tool-call":
        console.log(`  [llm:tool-call]  ${event.name} → ${JSON.stringify(event.arguments)}`);
        break;
      case "handoff": {
        console.log(`\n  ╔═══════════════════════════════════╗`);
        console.log(`  ║  HANDOFF EVENT                   ║`);
        console.log(`  ║  From: ${event.from.padEnd(30)}║`);
        console.log(`  ║  To:   ${event.to.padEnd(30)}║`);
        console.log(`  ║  Reason: ${event.reason.substring(0, 24).padEnd(26)}║`);
        console.log(`  ╚═══════════════════════════════════╝\n`);
        console.log("  → HandoffSignal caught by agent() loop");
        console.log("  → In a real system, the caller would now route to the target agent\n");
        break;
      }
      case "run:finished": {
        console.log(`  [run:finished] ${event.outcome.finishReason} (${event.outcome.totalSteps} steps)`);
        if (event.outcome.handoff) {
          console.log(`  → handoff target: ${event.outcome.handoff.targetAgent}`);
          console.log(`  → handoff reason: ${event.outcome.handoff.reason}`);
        }
        break;
      }
      default:
        if (event.type === "llm:delta") {
          process.stdout.write(`  [llm:delta] ${event.delta}`);
        } else if (event.type !== "step:started" && event.type !== "step:completed") {
          console.log(`  [${event.type}]`);
        }
    }
  }

  console.log("\nHandoff demo completed.");
}

main().catch(console.error);
