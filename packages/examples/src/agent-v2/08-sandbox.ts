/**
 * 08-sandbox.ts — agent-v2 + CubeSandbox (E2B) + Memory System demo
 *
 * Combines the functional agent pipeline with CubeSandboxBackend,
 * four-layer memory (Soul / User Profile / Memories / Skills),
 * and conversation history persistence.
 *
 * Memory layers:
 *   1. Soul — persistent personality traits
 *   2. User Profile — evolving user preferences & expertise
 *   3. Memories — facts, decisions, events, lessons (vector-retrieved)
 *   4. Skills — reusable problem-solving patterns (vector-retrieved)
 *
 * Prerequisites:
 *   Copy ../../cube-sandbox.json from ../../cube-sandbox.json.example
 *   Get API key from https://e2b.dev
 *   Set OPENAI_API_KEY for embedding generation
 *   Set MINIMAX_API_KEY for the LLM
 *
 * Run:
 *   pnpm --filter @renx/examples demo:agent-v2-sandbox [--session <id>]
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
  getContextMessages,
  clearContextWindow,
  getSessionId,
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
import * as readline from "node:readline";

// ── Config ───────────────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const configPath = resolve(__dirname, "../../cube-sandbox.json");

let fileConfig: Record<string, unknown> = {};
try {
  fileConfig = JSON.parse(readFileSync(configPath, "utf-8"));
} catch { /* optional */ }

const apiKey = (process.env.E2B_API_KEY ||
  process.env.CUBE_API_KEY ||
  fileConfig.apiKey) as string;
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

// ── LLM ──────────────────────────────────────────────────────────────────

const providerClient = createDefaultLLMClient({ vendors: ["minimax"] });
setDefaultLLMClient(createProviderBridge(providerClient));

// Use local Ollama for embeddings (nomic-embed-text-v2-moe)
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

// ── Memory Store (PostgreSQL + pgvector) ─────────────────────────────────

const pool = new pg.Pool({
  host: "localhost",
  port: 5432,
  database: "renx_memory",
});

const memoryStore = createPgVectorMemoryStore({ pool });

// ── Soul (persistent personality) ────────────────────────────────────────

const SOUL_CONTENT = `# Agent Soul

You are a coding assistant running inside an E2B sandbox. Your personality traits:

- Patient and thorough — explain your reasoning before writing code
- Safety-conscious — warn about potentially destructive operations
- Concise — prefer clean, readable code over clever one-liners
- Curious — ask clarifying questions when the task is ambiguous`;

// Seed the soul profile so the agent has a consistent personality from the start.
try {
  await memoryStore.upsertProfile({
    key: "soul",
    content: SOUL_CONTENT,
    version: 0,
    status: "active",
    metadata: {},
  });
} catch { /* may already exist */ }

// ── Tools ────────────────────────────────────────────────────────────────

const runCodeTool: Tool = {
  name: "run_code",
  description:
    "Execute Python code. When the `withSandbox` Plugin is active, execution is routed through E2B; otherwise it runs locally via python3.",
  parameters: z.object({
    code: z.string().describe("Python code to execute."),
  }),
  execute: async ({ code }) => {
    const stdout = execSync("python3", {
      input: code,
      encoding: "utf-8",
      timeout: 30_000,
    });
    return stdout.trimEnd();
  },
};

const echoTool: Tool = {
  name: "echo",
  description: "Echo a message back (runs locally, not sandboxed).",
  parameters: z.object({ message: z.string() }),
  execute: async ({ message }) => message.toUpperCase(),
};

// ── CLI args ─────────────────────────────────────────────────────────────

const sessionArg = process.argv.includes("--session")
  ? process.argv[process.argv.indexOf("--session") + 1]
  : undefined;

// ── Pipeline ─────────────────────────────────────────────────────────────
//
// Order matters (outer plugins see messages first):
//   1. withConversationHistory — load past messages from JSONL session file
//   2. withContextCompression   — compress oldest messages if over token budget
//   3. withMemory              — Soul/User/Memory/Skill injection into system prompt
//   4. withSandbox             — route tools through E2B
//   5. agent                   — core agent loop

const app = pipe(
  withConversationHistory({ sessionId: sessionArg }),
  withContextCompression({ maxTokens: 8000, keepLastN: 5, sessionId: getSessionId() }),
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

// ── Interactive REPL ─────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are a helpful coding assistant with memory. " +
  "Use run_code for code execution. " +
  "Use echo for non-code responses. " +
  "The Memory section below contains relevant context from past interactions — use it to personalize your responses.";

async function runTurn(model: string, input: string) {
  const gen = app({
    model,
    systemPrompt: SYSTEM_PROMPT,
    messages: [userMessage(input)],
    tools: [runCodeTool, echoTool],
    maxSteps: 100000,
  });

  for await (const event of gen) {
    switch (event.type) {
      case "llm:delta":
        process.stdout.write(event.delta);
        break;
      case "llm:tool-call":
        console.log(`\n[LLM] → calls ${event.name}(${JSON.stringify(event.arguments).slice(0, 100)})`);
        break;
      case "tool:start":
        console.log(`[TOOL] starting ${event.name}`);
        break;
      case "tool:result":
        console.log(`[TOOL] ok=${event.ok} output=${JSON.stringify(event.output).slice(0, 120)}`);
        break;
      case "tool:error":
        console.log(`[TOOL] ERROR: ${event.error}`);
        break;
      case "run:finished":
        console.log(`\n[DONE] ${event.outcome.totalSteps} steps, ${event.outcome.finishReason}`);
        break;
    }
  }
}

async function main() {
  const MODEL = minimax("MiniMax-M2.7");

  console.log("═".repeat(60));
  console.log("Agent-v2 + CubeSandbox (E2B) + Memory — Interactive REPL");
  console.log(`  Sandbox: ${sandbox.id}  (shared across turns)`);
  console.log(`  Model:   ${MODEL}`);
  console.log(`  Memory:  PostgreSQL + pgvector (nomic-embed-text-v2-moe)`);
  console.log(`  Pipeline: history → compression(8k) → memory → sandbox → agent`);
  if (sessionArg) {
    console.log(`  Session: ${sessionArg}  (resumed)`);
  } else {
    console.log(`  Session: ${getSessionId()}  (new — use --session <id> to resume)`);
  }
  console.log("  Type /exit to quit, /clear to reset context, /mem to inspect memory");
  console.log("═".repeat(60));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\n> ",
  });

  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      continue;
    }
    if (input === "/exit") break;
    if (input === "/clear") {
      clearContextWindow();
      console.clear();
      console.log("[Context window cleared. Memory store and audit log are preserved.]");
      rl.prompt();
      continue;
    }
    if (input === "/mem") {
      // Diagnostic: show entity graph + skill stats
      console.log("── Entities ──");
      const entities = ["python", "sandbox", "e2b", "renx-code-v4"];
      let found = 0;
      for (const eid of entities) {
        const entity = await memoryStore.getEntity(eid);
        if (entity) {
          found++;
          console.log(`  ${entity.name} [${entity.type}]`);
        }
      }
      if (found === 0) {
        console.log("  (none discovered yet)");
      }

      console.log("── Skills ──");
      const zeroVec = new Array(768).fill(0);
      const skills = await memoryStore.searchSkills({
        embedding: zeroVec,
        topK: 10,
        minSimilarity: -1,
      });
      if (skills.length === 0) {
        console.log("  (no skills generated yet)");
      } else {
        for (const s of skills) {
          const useCount = (s.metadata?.useCount as number) ?? 0;
          console.log(`  ${s.key} [${s.status}] used ${useCount}x`);
        }
      }

      console.log("── Profiles ──");
      const soul = await memoryStore.getProfile("soul");
      const user = await memoryStore.getProfile("user:default");
      console.log(`  soul: ${soul ? `v${soul.version} (${soul.content.length} chars)` : "none"}`);
      console.log(`  user:default: ${user ? `v${user.version} (${user.content.length} chars)` : "none"}`);

      console.log("── Context Window ──");
      const ctxMsgs = getContextMessages();
      if (ctxMsgs.length === 0) {
        console.log("  (empty)");
      } else {
        const ctxTokens = Math.ceil(ctxMsgs.reduce((sum, m) => {
          const c = typeof m.content === "string" ? m.content.length : 0;
          return sum + c / 4 + 4;
        }, 0));
        console.log(`  ${ctxMsgs.length} messages, ~${ctxTokens} tokens`);
        for (const m of ctxMsgs.slice(-5)) {
          const preview = typeof m.content === "string" ? m.content.slice(0, 60) : "[blocks]";
          console.log(`    [${m.role}] ${preview}${typeof m.content === "string" && m.content.length > 60 ? "..." : ""}`);
        }
      }

      rl.prompt();
      continue;
    }

    await runTurn(MODEL, input);
    rl.prompt();
  }

  rl.close();
  console.log("\nDisposing sandbox...");
  await sandbox.dispose();
  await pool.end();
  console.log("Goodbye.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  Promise.allSettled([sandbox.dispose(), pool.end()]).finally(() => process.exit(1));
});
