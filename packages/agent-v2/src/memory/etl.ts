/**
 * Memory Extraction Agent — uses agent-v2's agent() + Tool to extract
 * structured memories from a conversation.
 *
 * No fragile JSON-parsing. The LLM calls tools, zod validates input,
 * and each tool handles storage atomically with error handling.
 */
import { agent } from "../agent.js";
import type { Message } from "../message.js";
import { userMessage } from "../message.js";
import type { LLMClient } from "../llm-client.js";
import type { MemoryStore, Profile, MemoryType, EmbeddingClient, MemoryLogger, Entity } from "./store.js";
import type { Tool, ToolContext } from "../tool.js";
import { z } from "zod";

// ── Config ──────────────────────────────────────────

export type ExtractionConfig = {
  llmClient: LLMClient;
  model: string;
  store: MemoryStore;
  embeddingClient: EmbeddingClient;
  embeddingModel: string;
  userId: string;
  sessionId?: string;
  runId?: string;
  logger?: MemoryLogger;
};

// ── System Prompt ───────────────────────────────────

function buildSystemPrompt(soul: string, userProfile: string): string {
  const parts: string[] = [
    `You are a memory extraction specialist. Your job is to analyse the provided conversation and store any meaningful information as structured memories.

Call the appropriate tools to persist each insight. Do NOT output JSON or free text — only call tools. If nothing is worth remembering, call no tools and stop.

## When to call each tool

### storeMemory
For objective information discovered in the conversation:
- type "fact": objective truths about projects, codebases, tools, user background
- type "decision": explicit choices or decisions made
- type "event": milestone occurrences worth recording
- type "lesson": insights gained from successes or failures

### updateUserProfile
When the user reveals or updates information about themselves. Merge new information into the existing profile. Use short bullet lists under markdown headings like ## Expertise, ## Preferences, ## Goals.

### createSkill
When the conversation demonstrates a repeatable problem-solving pattern. Write a markdown fragment covering:
- When to use this skill (trigger conditions)
- How to approach (steps, tools to use)
- Common pitfalls

### suggestSoulEvolution
If the conversation suggests the agent's personality or approach should shift. This is rare — only use if there is a clear signal. The suggestion is logged for human review, not applied automatically.

## Entity names
Use short lowercase identifiers for entities (e.g. "renx-code-v4", "pnpm", "vitest").`,
  ];

  if (userProfile) {
    parts.push(`\n## Current User Profile\n${userProfile}`);
  }
  if (soul) {
    parts.push(`\n## Current Soul\n${soul}`);
  }

  return parts.join("\n");
}

// ── Retry ───────────────────────────────────────────

async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; baseDelayMs?: number; logger?: MemoryLogger },
): Promise<T> {
  const { maxRetries = 2, baseDelayMs = 1000 } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        opts.logger?.warn?.(
          `[memory ETL] Retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${err instanceof Error ? err.message : String(err)}`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ── Conversation Formatting ─────────────────────────

function concatMessages(messages: Message[]): string {
  return messages.map((m) => {
    if (m.role === "user") {
      return typeof m.content === "string" ? m.content : m.content.filter(c => c.type === "text").map(c => "text" in c ? c.text : "").join(" ");
    }
    if (m.role === "assistant") {
      return (m.content ?? "") + (m.toolCalls?.length ? ` [used tools: ${m.toolCalls.map(tc => tc.name).join(", ")}]` : "");
    }
    if (m.role === "tool") {
      return `[tool: ${m.toolCallId} → ${m.content.slice(0, 100)}]`;
    }
    return "";
  }).filter(Boolean).join("\n");
}

// ── Tools ───────────────────────────────────────────

function buildTools(config: ExtractionConfig): Tool[] {
  const log = config.logger;

  return [
    {
      name: "storeMemory",
      description:
        "Store a new memory extracted from the conversation. Call once per distinct insight.",
      parameters: z.object({
        content: z
          .string()
          .min(1)
          .max(200)
          .describe("Concise single-sentence memory"),
        summary: z
          .string()
          .min(1)
          .max(50)
          .describe("Ultra-short version for embedding-based retrieval"),
        type: z
          .enum(["fact", "decision", "event", "lesson"])
          .describe("Memory category"),
        entities: z
          .array(
            z.object({
              name: z.string().min(1).describe("Entity name (lowercase identifier)"),
              entityType: z
                .enum(["project", "tool", "concept", "person", "skill"])
                .default("concept")
                .describe("Entity type"),
            }),
          )
          .max(10)
          .default([])
          .describe("Related entities with their types"),
      }),
      execute: async (input: Record<string, unknown>, _ctx: ToolContext) => {
        try {
          const embedding = await withRetry(
            () =>
              config.embeddingClient.generateEmbedding({
                model: config.embeddingModel,
                input: input.summary as string,
              }),
            { logger: log },
          );
          if (!embedding.embeddings[0]) {
            log?.error?.(`[memory ETL] Empty embedding for memory: ${input.summary}`);
            return { ok: false, error: "No embedding returned" };
          }

          const mem = await config.store.storeMemory({
            content: input.content as string,
            summary: input.summary as string,
            embedding: embedding.embeddings[0],
            type: input.type as MemoryType,
            importance: 0.5,
            sessionId: config.sessionId,
            runId: config.runId,
          });

          const entities = (input.entities as Array<{ name: string; entityType: Entity["type"] }>) ?? [];
          for (const e of entities) {
            const entityId = e.name.toLowerCase().replace(/\s+/g, "-");
            try {
              await config.store.upsertEntity({
                id: entityId,
                name: e.name,
                type: e.entityType,
                properties: {},
              });
              await config.store.linkMemoryEntities(mem.id, [entityId]);
            } catch (err) {
              log?.error?.(`[memory ETL] Failed to link entity "${e.name}" to memory ${mem.id}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          return { ok: true, memoryId: mem.id, type: input.type as string };
        } catch (err) {
          log?.error?.(`[memory ETL] storeMemory failed: ${err instanceof Error ? err.message : String(err)}`);
          return { ok: false, error: err instanceof Error ? err.message : "Memory storage failed" };
        }
      },
    },

    {
      name: "updateUserProfile",
      description:
        "Update the user's profile with new or changed information. Merge into the existing MD content under relevant markdown headings.",
      parameters: z.object({
        profileMD: z
          .string()
          .min(1)
          .describe("Complete updated user profile in markdown (approx 200 tokens, use bullet lists)"),
      }),
      execute: async (input: Record<string, unknown>, _ctx: ToolContext) => {
        try {
          await config.store.upsertProfile({
            key: `user:${config.userId}`,
            content: input.profileMD as string,
            version: 0,
            status: "active",
            metadata: {},
          });
          return { ok: true };
        } catch (err) {
          log?.error?.(`[memory ETL] updateUserProfile failed: ${err instanceof Error ? err.message : String(err)}`);
          return { ok: false, error: err instanceof Error ? err.message : "Profile update failed" };
        }
      },
    },

    {
      name: "createSkill",
      description:
        "Create a reusable skill from a repeatable pattern observed in the conversation. Include WHEN to use, HOW to approach, and common pitfalls.",
      parameters: z.object({
        skillMD: z
          .string()
          .min(1)
          .describe("Markdown skill fragment covering trigger conditions, approach steps, and pitfalls"),
      }),
      execute: async (input: Record<string, unknown>, _ctx: ToolContext) => {
        try {
          const skillContent = input.skillMD as string;
          const embedding = await withRetry(
            () =>
              config.embeddingClient.generateEmbedding({
                model: config.embeddingModel,
                input: skillContent.slice(0, 800),
              }),
            { logger: log },
          );

          const h = simpleHash(skillContent.slice(0, 200));
          const skillId = `skill:${Date.now().toString(36)}-${h}`;

          await config.store.upsertProfile({
            key: skillId,
            content: skillContent,
            version: 0,
            status: "pending",
            embedding: embedding.embeddings[0],
            metadata: { successRate: 0, useCount: 0 },
          });
          return { ok: true, skillId };
        } catch (err) {
          log?.error?.(`[memory ETL] createSkill failed: ${err instanceof Error ? err.message : String(err)}`);
          return { ok: false, error: err instanceof Error ? err.message : "Skill creation failed" };
        }
      },
    },

    {
      name: "suggestSoulEvolution",
      description:
        "Suggest an adjustment to the agent's personality or approach. ONLY use when the conversation clearly signals a different style is needed. Rare.",
      parameters: z.object({
        suggestion: z
          .string()
          .min(1)
          .describe("What to change and why — logged for human review, not applied automatically"),
      }),
      execute: async (input: Record<string, unknown>, _ctx: ToolContext) => {
        const msg = input.suggestion as string;
        if (log?.info) {
          log.info(`[memory ETL] Soul evolution suggested: ${msg}`);
        } else {
          console.log(`[memory ETL] Soul evolution suggested:\n${msg}`);
        }
        return { ok: true, note: "Logged for human review" };
      },
    },
  ];
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

// ── Public API ──────────────────────────────────────

export async function runMemoryExtraction(params: {
  config: ExtractionConfig;
  messages: Message[];
  userProfile: Profile | null;
  soulProfile: Profile | null;
}): Promise<boolean> {
  const { config, messages, userProfile, soulProfile } = params;

  const systemPrompt = buildSystemPrompt(
    soulProfile?.content ?? "",
    userProfile?.content ?? "",
  );

  const conversationText = concatMessages(messages);
  if (!conversationText.trim()) return false;

  let success = true;
  try {
    const gen = agent({
      model: config.model,
      systemPrompt,
      messages: [userMessage(conversationText)],
      tools: buildTools(config),
      llmClient: config.llmClient,
      maxSteps: 10,
    });

    for await (const event of gen) {
      if (event.type === "tool:error") {
        success = false;
        config.logger?.error?.(`[memory ETL] Tool error (${event.callId}): ${event.error}`);
      }
    }
  } catch (err) {
    config.logger?.error?.(`[memory ETL] Extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  return success;
}
