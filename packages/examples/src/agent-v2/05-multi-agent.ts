/**
 * 05-multi-agent.ts — Agent-as-Tool demo with real LLM + real web search
 *
 * Demonstrates:
 *   - agentAsTool() — wrapping a child agent as a tool for a parent to call
 *   - Parent agent delegates subtasks to specialized child agents
 *   - Researcher agent uses search_web (DuckDuckGo) for real results
 *   - Writer agent uses real LLM to produce a formatted summary
 *   - Event forwarding from child to parent
 *
 * Prerequisites: set MINIMAX_API_KEY
 * Run: pnpm demo:agent-v2-multi-agent
 */
import {
  agent,
  setDefaultLLMClient,
} from "@renx/agent-v2";
import { userMessage } from "@renx/agent-v2";
import { agentAsTool } from "@renx/agent-v2/multi-agent";
import { createProviderBridge } from "@renx/agent-v2/providers";
import { createDefaultLLMClient, minimax } from "@renx/provider";
import type { AgentInput, AgentGenerator, AgentEvent } from "@renx/agent-v2";
import { z } from "zod";

// ─── Setup ───
const providerClient = createDefaultLLMClient({ vendors: ["minimax"] });
setDefaultLLMClient(createProviderBridge(providerClient));

const MODEL = minimax("MiniMax-M2.7");

// ─── Web search tool (DuckDuckGo — free, no API key needed) ───

const searchTool = {
  name: "search_web",
  description: "Search the web using DuckDuckGo Instant Answer API. Returns relevant abstracts and related topics.",
  parameters: z.object({ query: z.string().describe("The search query") }),
  async execute(input: { query: string }) {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(input.query)}&format=json&no_html=1&no_redirect=1`;
    const res = await fetch(url);
    const data = (await res.json()) as {
      AbstractText?: string;
      AbstractURL?: string;
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
    };
    const results: string[] = [];
    if (data.AbstractText) {
      results.push(`[Abstract] ${data.AbstractText}${data.AbstractURL ? ` (${data.AbstractURL})` : ""}`);
    }
    if (data.RelatedTopics) {
      for (const topic of data.RelatedTopics.slice(0, 4)) {
        if (topic.Text) {
          results.push(`[Topic] ${topic.Text}${topic.FirstURL ? ` (${topic.FirstURL})` : ""}`);
        }
      }
    }
    const text = results.join("\n\n");
    return { query: input.query, results: text || "(No results found for this query)" };
  },
};

// ─── Specialized child agents (real LLM + tools) ───

async function* researcherAgent(input: AgentInput): AgentGenerator {
  console.log("\n  [child:research] Starting web search...\n");
  try {
    yield* agent({
      ...input,
      model: input.model || MODEL,
      tools: [searchTool],
      systemPrompt: (input.systemPrompt ?? "You are a researcher.") +
        "\nUse search_web to find current information. Then summarize concisely.",
      maxSteps: 5,
    });
  } catch (err) {
    console.error("  [child:research] ERROR:", err);
    throw err;
  }
}

async function* writerAgent(input: AgentInput): AgentGenerator {
  try {
    yield* agent({
      ...input,
      model: input.model || MODEL,
      systemPrompt: (input.systemPrompt ?? "You are a technical writer.") +
        "\nWrite a well-structured summary. Use bullet points for key findings.",
      maxSteps: 3,
    });
  } catch (err) {
    console.error("  [child:writer] ERROR:", err);
    throw err;
  }
}

// ─── Wrap child agents as tools ───

const researchTool = agentAsTool({
  name: "research",
  description: "Research a topic using web search and return findings.",
  agent: researcherAgent,
  buildInput: (args: Record<string, unknown>) => ({
    model: MODEL,
    systemPrompt: "You are a web researcher. Use search_web to find current information on the topic, then summarize.",
    messages: [userMessage(String(args.query ?? args.question ?? "Unknown"))],
  }),
  onChildEvent: (evt: AgentEvent) => {
    if (evt.type === "llm:delta") process.stdout.write(evt.delta);
    if (evt.type === "llm:tool-call") console.log(`\n  [child:research:tool-call] ${evt.name}(${JSON.stringify(evt.arguments)})`);
  },
});

const writerTool = agentAsTool({
  name: "write_summary",
  description: "Write a formatted summary of provided research content.",
  agent: writerAgent,
  buildInput: (args: Record<string, unknown>) => ({
    model: MODEL,
    systemPrompt: "You are a technical writer. Produce a clear, structured summary.",
    messages: [userMessage(`Summarize:\n\n${String(args.content ?? args.input ?? "No content")}`)],
  }),
  onChildEvent: (evt: AgentEvent) => {
    if (evt.type === "llm:delta") process.stdout.write(evt.delta);
  },
});

// ─── Main ───

async function main() {
  console.log("=== agent-v2 Multi-Agent (Agent-as-Tool) Demo ===\n");
  console.log(`Model: ${MODEL}`);
  console.log("Parent delegates to 'research' (with real web search) and 'write_summary'.\n");

  console.log("Events:\n");

  for await (const event of agent({
    model: MODEL,
    systemPrompt:
      "You are an orchestrator. Follow this process:\n" +
      "1. First call 'research' with a specific search query about the topic.\n" +
      "2. Then call 'write_summary', passing the research results as 'content'.\n" +
      "Always follow this two-step process. Do not answer directly — always delegate.",
    messages: [userMessage("查一下github 最新最热项目")],
    tools: [researchTool, writerTool],
    maxSteps: 5,
  })) {
    switch (event.type) {
      case "step:started":
        console.log(`\n── Step ${event.step} ──`);
        break;
      case "llm:tool-call":
        console.log(`  [parent:llm:tool-call] → ${event.name}(${JSON.stringify(event.arguments)})`);
        break;
      case "tool:start":
        console.log(`  [parent:tool:start]     ${event.name}`);
        break;
      case "tool:result":
        console.log(`  [parent:tool:result]    ${event.callId} ok=${event.ok} (${event.durationMs}ms)`);
        break;
      case "tool:error":
        console.log(`  [parent:tool:error]     ${event.callId} → ${event.error}`);
        break;
      case "run:finished":
        console.log(`\n  [parent:run:finished] finishReason=${event.outcome.finishReason} totalSteps=${event.outcome.totalSteps}`);
        console.log(`\n══════ Final Result ══════`);
        console.log(event.outcome.text);
        console.log(`═════════════════════════`);
        break;
    }
  }

  console.log("\nMulti-agent demo completed.");
  console.log("\nArchitecture: Parent (MiniMax) → research agent (MiniMax + search_web) → writer agent (MiniMax).");
}

main().catch(console.error);
