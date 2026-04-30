/**
 * 08-sandbox-multi.ts — 多轮对话 ETL 测试
 * 复用 08-sandbox 的 pipeline，自动发送多轮消息，验证 Memory ETL 提取效果
 */
import {
  agent,
  setDefaultLLMClient,
  userMessage,
  pipe,
  createPgVectorMemoryStore,
} from "@renx/agent-v2";
import pg from "pg";
import {
  withSandbox,
  withMemory,
  withConversationHistory,
  withContextCompression,
  getSessionId,
  getContextMessages,
} from "@renx/agent-v2/plugins";
import { createProviderBridge } from "@renx/agent-v2/providers";
import { createDefaultLLMClient, minimax } from "@renx/provider";
import type { Tool, EmbeddingClient } from "@renx/agent-v2";
import { z } from "zod";
import { CubeSandboxBackend } from "@renx/agent";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const configPath = resolve(__dirname, "../../cube-sandbox.json");

let fileConfig: Record<string, unknown> = {};
try { fileConfig = JSON.parse(readFileSync(configPath, "utf-8")); } catch { /* optional */ }

const apiKey = (process.env.E2B_API_KEY || process.env.CUBE_API_KEY || fileConfig.apiKey) as string;
if (!apiKey || apiKey === "dummy") {
  console.error("Set apiKey in cube-sandbox.json or E2B_API_KEY env var.");
  process.exit(1);
}

const sandbox = new CubeSandboxBackend({
  apiKey,
  apiUrl: (process.env.E2B_API_URL || fileConfig.apiUrl) as string || "https://api.e2b.dev",
  templateId: (fileConfig.templateId as string) || undefined,
  timeoutMs: (fileConfig.timeoutMs as number) || 60_000,
});

const providerClient = createDefaultLLMClient({ vendors: ["minimax"] });
setDefaultLLMClient(createProviderBridge(providerClient));

const embeddingClient: EmbeddingClient = {
  generateEmbedding: async (opts) => {
    const resp = await fetch("http://localhost:11434/api/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: opts.model, prompt: opts.input }),
    });
    if (!resp.ok) throw new Error(`Ollama embeddings failed: HTTP ${resp.status}`);
    const data = await resp.json() as { embedding: number[] };
    return { embeddings: [data.embedding] };
  },
};

const pool = new pg.Pool({ host: "localhost", port: 5432, database: "renx_memory" });
const memoryStore = createPgVectorMemoryStore({ pool });

const SOUL_CONTENT = `# Agent Soul

You are a coding assistant running inside an E2B sandbox. Your personality traits:

- Patient and thorough — explain your reasoning before writing code
- Safety-conscious — warn about potentially destructive operations
- Concise — prefer clean, readable code over clever one-liners
- Curious — ask clarifying questions when the task is ambiguous`;

try {
  await memoryStore.upsertProfile({
    key: "soul", content: SOUL_CONTENT, version: 0, status: "active", metadata: {},
  });
} catch { /* may already exist */ }

const runCodeTool: Tool = {
  name: "run_code",
  description: "Execute Python code in the sandbox.",
  parameters: z.object({ code: z.string().describe("Python code to execute.") }),
  execute: async ({ code }) => {
    const stdout = execSync("python3", { input: code, encoding: "utf-8", timeout: 30_000 });
    return stdout.trimEnd();
  },
};

const echoTool: Tool = {
  name: "echo",
  description: "Echo a message back (runs locally, not sandboxed).",
  parameters: z.object({ message: z.string() }),
  execute: async ({ message }) => message.toUpperCase(),
};

const app = pipe(
  withConversationHistory({}),
  withContextCompression({ maxTokens: 8000, keepLastN: 10, sessionId: getSessionId() }),
  withMemory({
    store: memoryStore,
    embeddingClient,
    embeddingModel: "nomic-embed-text-v2-moe",
    minSimilarity: 0.6,
    memoryTopK: 5,
    skillTopK: 3,
  }),
  withSandbox({ sandbox, tools: ["run_code"] }),
  agent,
);

const SYSTEM_PROMPT =
  "You are a helpful coding assistant with memory. " +
  "Use run_code for code execution. " +
  "Use echo for non-code responses. " +
  "The Memory section below contains relevant context from past interactions — use it to personalize your responses.";

const MODEL = minimax("MiniMax-M2.7");

async function runTurn(input: string): Promise<string> {
  const gen = app({
    model: MODEL,
    systemPrompt: SYSTEM_PROMPT,
    messages: [userMessage(input)],
    tools: [runCodeTool, echoTool],
    maxSteps: 100000,
  });

  let text = "";
  let stepCount = 0;
  let finishReason = "";

  for await (const event of gen) {
    switch (event.type) {
      case "llm:delta":
        text += event.delta;
        break;
      case "llm:tool-call":
        console.log(`  [LLM] → ${event.name}(${JSON.stringify(event.arguments).slice(0, 80)})`);
        break;
      case "tool:start":
        console.log(`  [TOOL] ${event.name}`);
        break;
      case "tool:result":
        console.log(`  [TOOL] ok=${event.ok} ${JSON.stringify(event.output).slice(0, 80)}`);
        break;
      case "run:finished":
        stepCount = event.outcome.totalSteps;
        finishReason = event.outcome.finishReason;
        break;
    }
  }

  console.log(`  [DONE] ${stepCount} steps, ${finishReason}`);
  // Multi-pass ETL can take 30+ seconds — wait for async completion
  await new Promise(r => setTimeout(r, 5000));
  return text;
}

async function showMemoryState(label: string) {
  console.log(`\n── Memory @ ${label} ──`);

  const { rows: memories } = await pool.query(
    `SELECT type, importance, left(summary, 80) as summary, created_at FROM agent_v2_memories ORDER BY created_at DESC`
  );
  console.log(`  Memories (${memories.length}):`);
  for (const m of memories) {
    console.log(`    [${m.type}] importance=${m.importance} "${m.summary}"`);
  }

  const { rows: profiles } = await pool.query(
    `SELECT key, version, status, left(content, 60) as preview FROM agent_v2_profiles`
  );
  console.log(`  Profiles (${profiles.length}):`);
  for (const p of profiles) {
    console.log(`    ${p.key}: v${p.version} [${p.status}] "${p.preview}..."`);
  }

  const { rows: entities } = await pool.query(`SELECT id, name, type FROM agent_v2_entities`);
  console.log(`  Entities (${entities.length}):`);
  for (const e of entities) {
    console.log(`    ${e.id} [${e.type}] "${e.name}"`);
  }

  const { rows: relations } = await pool.query(
    `SELECT from_entity, type, to_entity FROM agent_v2_relations`
  );
  console.log(`  Relations (${relations.length}):`);
  for (const r of relations) {
    console.log(`    ${r.from_entity} --[${r.type}]--> ${r.to_entity}`);
  }
}

async function main() {
  console.log("=".repeat(60));
  console.log("Multi-turn ETL Test — Memory Extraction Pipeline");
  console.log(`  Session: ${getSessionId()}`);
  console.log(`  Model:   ${MODEL}`);
  console.log("=".repeat(60));

  const turns = [
    "Write a Python function that calculates the Fibonacci sequence up to n. Use run_code to test it with n=10.",
    "That Fibonacci function is good, but can you optimize it? Use run_code to show me the performance difference.",
    "Now write a Python function to check if a string is a palindrome. Test it with 'racecar'.",
  ];

  for (let i = 0; i < turns.length; i++) {
    console.log(`\n── Turn ${i + 1} ──`);
    console.log(`> ${turns[i].slice(0, 60)}...`);
    const text = await runTurn(turns[i]);
    console.log(`  Response: ${text.slice(0, 120)}${text.length > 120 ? "..." : ""}`);
  }

  // Show final memory state
  await showMemoryState("After 3 turns");

  console.log("\nDisposing sandbox...");
  await sandbox.dispose();
  await pool.end();
  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  Promise.allSettled([sandbox.dispose(), pool.end()]).finally(() => process.exit(1));
});
