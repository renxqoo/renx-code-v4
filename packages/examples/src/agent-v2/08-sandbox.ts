/**
 * 08-sandbox.ts — agent-v2 + CubeSandbox (E2B) demo
 *
 * Combines the functional agent pipeline with CubeSandboxBackend.
 * Uses the `withSandbox` Plugin to route code execution through E2B.
 *
 * Prerequisites:
 *   Copy ../../cube-sandbox.json from ../../cube-sandbox.json.example
 *   Get API key from https://e2b.dev
 *   Set OPENAI_API_KEY for the LLM
 *
 * Run:
 *   pnpm --filter @renx/examples demo:agent-v2-sandbox
 */

import { agent, setDefaultLLMClient, userMessage } from "@renx/agent-v2";
import { pipe } from "@renx/agent-v2";
import { withSandbox } from "@renx/agent-v2/plugins";
import { createProviderBridge } from "@renx/agent-v2/providers";
import { createDefaultLLMClient, minimax } from "@renx/provider";
import type { Tool } from "@renx/agent-v2";
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

// ── Tools ────────────────────────────────────────────────────────────────

const runCodeTool: Tool = {
  name: "run_code",
  description: "Execute Python code. When the `withSandbox` Plugin is active, execution is routed through E2B; otherwise it runs locally via python3.",
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

// ── Pipeline ─────────────────────────────────────────────────────────────

const app = pipe(
  withSandbox({ sandbox, tools: ["run_code"] }),
  agent,
);

// ── Interactive REPL ─────────────────────────────────────────────────────

async function runTurn(input: string, model: string) {
  const gen = app({
    model,
    systemPrompt:
      "You are a helpful assistant. When asked to run code, use run_code. For everything else, use echo.",
    messages: [userMessage(input)],
    tools: [runCodeTool, echoTool],
    maxSteps: 50,
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
  console.log("Agent-v2 + CubeSandbox (E2B) — Interactive REPL");
  console.log(`  Sandbox: ${sandbox.id}  (shared across turns)`);
  console.log(`  Model:   ${MODEL}`);
  console.log("  Type /exit to quit, /clear to clear terminal");
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
      console.clear();
      rl.prompt();
      continue;
    }

    await runTurn(input, MODEL);
    rl.prompt();
  }

  rl.close();
  console.log("\nDisposing sandbox...");
  await sandbox.dispose();
  console.log("Goodbye.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  sandbox.dispose().finally(() => process.exit(1));
});
