/**
 * 09-cube-sandbox.ts — CubeSandbox / E2B backend demo
 *
 * Demonstrates routing tool execution through an E2B-compatible sandbox
 * (CubeSandbox or E2B hosted service with hardware-level isolation).
 *
 * Prerequisites:
 *   1. Copy cube-sandbox.json.example → cube-sandbox.json and set your apiKey
 *   2. Get API key from https://e2b.dev (or use self-hosted CubeSandbox)
 *
 * Run:
 *   pnpm demo:agent-cube-sandbox
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  CubeSandboxBackend,
  SandboxRegistry,
} from "@renx/agent";

// ── Configuration ────────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const configPath = resolve(__dirname, "../../cube-sandbox.json");

let fileConfig: Record<string, unknown> = {};
try {
  fileConfig = JSON.parse(readFileSync(configPath, "utf-8"));
  console.log(`Loaded config from ${configPath}`);
} catch {
  // Config file is optional — env vars are sufficient.
}

function config(key: string, fallback?: string): string | undefined {
  return process.env[key] ?? (fileConfig[key] as string | undefined) ?? fallback;
}

const apiKey = config("CUBE_API_KEY") ?? fileConfig.apiKey as string;
if (!apiKey || apiKey === "dummy") {
  console.error(
    "A valid apiKey is required.\n" +
      "\nOptions:" +
      "\n  1. Copy cube-sandbox.json.example → cube-sandbox.json and set your apiKey" +
      "\n  2. Get a free API key at https://e2b.dev" +
      "\n  3. Or set CUBE_API_KEY=<key> pnpm demo:agent-cube-sandbox",
  );
  process.exit(1);
}

const apiUrl = config("CUBE_API_URL") ?? fileConfig.apiUrl as string ?? "https://api.e2b.dev";
const fileTemplateId = fileConfig.templateId as string;
const templateId: string | undefined = config("CUBE_TEMPLATE_ID") || fileTemplateId || undefined;
const timeoutMs = Number(config("CUBE_TIMEOUT_MS") ?? fileConfig.timeoutMs ?? 60000);

// ── Tools ────────────────────────────────────────────────────────────────

/**
 * A code-interpreter tool.  The backend extracts the `code` field from args
 * and runs it inside the CubeSandbox microVM.
 */
const runCodeTool = {
  id: "cube_run_code",
  name: "Run Code",
  description: "Execute JavaScript/Python code in an isolated sandbox.",
  type: "read_only" as const,
  schema: z.object({
    code: z.string().describe("Code to execute in the sandbox."),
  }),
  execute: async (args: Record<string, unknown>) => {
    // Not called directly: the CubeSandboxBackend intercepts execution.
    // This is a fallback for in-process execution if sandbox routing fails.
    return {
      success: true,
      content: `Fallback: args = ${JSON.stringify(args)}`,
      metadata: { args },
    };
  },
  sandboxProfileId: "cube_sandbox",
};

// ── Sandbox setup ────────────────────────────────────────────────────────

const cubeBackend = new CubeSandboxBackend({
  templateId,
  apiUrl,
  apiKey,
  timeoutMs,
});

const registry = new SandboxRegistry(cubeBackend).register(
  "cube_sandbox",
  cubeBackend,
);

// ── Demo ─────────────────────────────────────────────────────────────────

async function main() {
  console.log("═".repeat(60));
  console.log("CubeSandbox Demo");
  console.log(`  API:  ${apiUrl}`);
  console.log(`  Tmpl: ${templateId}`);
  console.log("═".repeat(60));

  // Resolve the backend via the registry (same as toolExecutor does).
  const backend = registry.resolve("cube_sandbox");
  console.log(`\nResolved backend: ${backend.id}`);

  // --- Demo 1: Simple expression ---
  console.log("\n── Demo 1: simple expression ──");
  try {
    const result = await backend.execute({
      tool: runCodeTool,
      args: { code: "2 + 2" },
      callId: "demo-1",
      context: {
        profileId: "cube_sandbox",
        tenantId: "demo",
        traceId: "demo-1-trace",
      },
    });

    console.log("  success:", result.success);
    console.log("  content:", result.content);
    console.log("  metadata:", JSON.stringify(result.metadata, null, 2));
  } catch (err) {
    console.error("  FAILED:", err);
  }

  // --- Demo 2: Python code ---
  console.log("\n── Demo 2: Python print + arithmetic ──");
  try {
    const result = await backend.execute({
      tool: runCodeTool,
      args: { code: "print('Hello from CubeSandbox!')\nsum(range(1, 101))" },
      callId: "demo-2",
      context: {
        profileId: "cube_sandbox",
        tenantId: "demo",
        traceId: "demo-2-trace",
      },
    });

    console.log("  success:", result.success);
    console.log("  content:", result.content);
  } catch (err) {
    console.error("  FAILED:", err);
  }

  // --- Demo 3: Error handling ---
  console.log("\n── Demo 3: deliberate syntax error ──");
  try {
    const result = await backend.execute({
      tool: runCodeTool,
      args: { code: "raise ValueError('bad input')" },
      callId: "demo-3",
      context: {
        profileId: "cube_sandbox",
        tenantId: "demo",
        traceId: "demo-3-trace",
      },
    });

    console.log("  success:", result.success);
    console.log("  content:", result.content);
  } catch (err) {
    console.error("  FAILED:", err);
  }

  console.log("\n═".repeat(60));
  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
