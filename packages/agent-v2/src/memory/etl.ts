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
    `You are a thorough memory extraction agent. Mine the conversation below for ALL structured knowledge worth remembering. A technical conversation contains 5-15 distinct insights — extract EVERY one.

## CRITICAL: Tool calls only — NO text output

After each tool call, immediately call the NEXT tool. Do NOT write any text. Do NOT summarize or say "I've stored...". Only tool calls, one after another, until every insight is extracted. The system stops automatically when you run out of tools. Calling only 1-2 tools is a FAILURE.

## Core rule

Call the appropriate tools for EVERY insight. If in doubt, CALL THE TOOL. Think exhaustively:
- What was the user's task? → fact
- What tools/tech were used? → fact
- What code was written? → fact
- What were the results? → fact
- Any explicit choices? → decision
- Any errors or fixes? → lesson
- Any performance numbers? → lesson or fact
- Did user reveal anything about themselves? → updateUserProfile
- Was a repeatable workflow demonstrated? → createSkill

## storeMemory — extract ALL of these

Run a mental checklist over the conversation and call storeMemory for EACH match:

### facts (up to 500 chars each)
- What task was the user working on? (domain, goal, context)
- What technologies, libraries, or tools were used or discussed? (name + version if visible)
- What code patterns, APIs, or data structures appeared?
- What concrete results were produced? (benchmarks, outputs, errors)
- What is the user's tech stack or environment?
- What configuration or setup details were revealed?

### decisions
- Any explicit choice between alternatives (e.g. "let's use X instead of Y")
- Architecture or design decisions made
- Tool or library selections with rationale

### events
- Milestones: "first working version", "deployment completed"
- Discoveries: "found the root cause", "uncovered a bug"
- Breakthroughs: "solved the performance issue", "got it working"

### lessons
- What went wrong and why? (error → cause → fix)
- Performance insights with concrete numbers
- Best practices discovered or reinforced
- Surprising or non-obvious findings

## storeMemory parameters

- **content**: Detailed 1-3 sentence description (keep relevant technical detail, aim for 50-500 chars). Include numbers, error messages, or key code where useful.
- **summary**: VERY short (3-8 words) for retrieval. Good: "iterative Fibonacci is O(n) time O(1) space". Bad: "Fibonacci".
- **type**: One of fact/decision/event/lesson.
- **entities**: List ALL relevant entity names (tools, libraries, concepts, projects). Use short lowercase identifiers like "python", "fibonacci", "performance".

## updateUserProfile

Call when the conversation reveals ANYTHING about the user:
- Technical expertise level (languages, frameworks, domains)
- Preferences (coding style, tools, approaches)
- Goals (what are they building, learning, debugging?)
- Constraints (deadlines, platform, budget)

Write the updated profile as bullet lists under markdown headings:
## Expertise | ## Preferences | ## Goals | ## Constraints

Merge new info into existing profile rather than replacing it wholesale. If profile mentions "knows Python" and the conversation shows numpy usage, the update should say "knows Python (including numpy)".

## createSkill

Call when the conversation demonstrates a repeatable workflow. Good signals:
- User says "next time" or "going forward" or "every time I..."
- A multi-step debugging or optimization approach was demonstrated
- A specific sequence of tools was used to solve a problem

The skill MD should cover:
1. **Trigger**: When to apply this skill (1-2 sentences)
2. **Steps**: Ordered approach (3-6 bullet points)
3. **Pitfalls**: Common mistakes (1-3 bullets)
4. **Tools used**: List specific tool names if applicable

## suggestSoulEvolution

Rare. Only call if the conversation clearly shows the agent's style was wrong for the user (too verbose, too terse, wrong tone).

## Entity naming

Use short kebab-case identifiers:
- Good: "python", "fibonacci-algorithm", "e2b-sandbox", "benchmarking"
- Bad: "The Fibonacci Algorithm", "Python Programming Language"`,
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
  return messages.map((m, i) => {
    if (m.role === "user") {
      const text = typeof m.content === "string"
        ? m.content
        : m.content.filter(c => c.type === "text").map(c => "text" in c ? c.text : "").join(" ");
      return `[#${i} USER] ${text}`;
    }
    if (m.role === "assistant") {
      const text = (m.content ?? (m.toolCalls?.length ? "(tool calls only)" : "(empty)"));
      const toolNote = m.toolCalls?.length
        ? `\n  [called ${m.toolCalls.length} tool(s): ${m.toolCalls.map(tc => `${tc.name}(${JSON.stringify(tc.arguments).slice(0, 60)})`).join(", ")}]`
        : "";
      return `[#${i} ASSISTANT] ${text.slice(0, 200)}${toolNote}`;
    }
    if (m.role === "tool") {
      // Keep full output — critical for extracting facts/lessons from tool results
      const output = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `[#${i} TOOL ${m.toolCallId}] ${output}`;
    }
    return `[#${i} ${m.role}] ${JSON.stringify(m).slice(0, 200)}`;
  }).filter(Boolean).join("\n\n");
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
          .max(500)
          .describe("Detailed 1-3 sentence description with relevant technical detail, numbers, error messages"),
        summary: z
          .string()
          .min(1)
          .max(80)
          .describe("Ultra-short (3-8 words) for embedding retrieval. Good: 'iterative Fibonacci O(n) O(1)'. Bad: 'Fibonacci'."),
        type: z
          .enum(["fact", "decision", "event", "lesson"])
          .describe("Memory category"),
        importance: z
          .number()
          .min(0)
          .max(1)
          .default(0.5)
          .describe("0.0-1.0. Higher for key decisions, critical bugs, or core project facts. Lower for minor observations."),
        entities: z
          .array(
            z.object({
              name: z.string().min(1).describe("Entity name (lowercase kebab-case identifier)"),
              entityType: z
                .enum(["project", "tool", "concept", "person", "skill"])
                .default("concept")
                .describe("Entity type"),
            }),
          )
          .max(10)
          .default([])
          .describe("All related entities (tools, libraries, concepts, projects)"),
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
            importance: (input.importance as number) ?? 0.5,
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

  const tools = buildTools(config);

  // Track what was already extracted to prevent duplicates across passes
  const extractedSummaries = new Set<string>();
  const extractedSkills = new Set<string>();
  let userProfileUpdated = false;
  let toolCallCount = 0;
  let success = true;

  // ── Multi-pass extraction ──
  // The LLM often outputs text and stops after 1-2 tool calls.
  // We run up to 3 passes, each starting with a follow-up message
  // prompting the model to extract more.
  const MAX_PASSES = 3;
  const MIN_TOOL_CALLS = 5; // Aim for at least this many total calls

  let currentMessages: Message[] = [userMessage(conversationText)];

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const passStartCallCount = toolCallCount;

    try {
      const gen = agent({
        model: config.model,
        systemPrompt,
        messages: currentMessages,
        tools,
        llmClient: config.llmClient,
        maxSteps: 10,
      });

      // Map callId → tool name + args for matching with tool:result
      const pendingCalls = new Map<string, { name: string; args: Record<string, unknown> }>();

      for await (const event of gen) {
        if (event.type === "tool:error") {
          success = false;
          config.logger?.error?.(`[memory ETL] Tool error (${event.callId}): ${event.error}`);
        }
        if (event.type === "llm:tool-call") {
          pendingCalls.set(event.id, { name: event.name, args: event.arguments });
        }
        if (event.type === "tool:result" && event.ok) {
          toolCallCount++;
          // Track extractables from tool call events
          const callInfo = pendingCalls.get(event.callId);
          if (callInfo) {
            if (callInfo.name === "storeMemory") {
              const summary = callInfo.args.summary as string | undefined;
              if (summary) extractedSummaries.add(summary);
            } else if (callInfo.name === "createSkill") {
              const skillMD = callInfo.args.skillMD as string | undefined;
              if (skillMD) extractedSkills.add(skillMD.slice(0, 80));
            } else if (callInfo.name === "updateUserProfile") {
              userProfileUpdated = true;
            }
          }
        }
      }

      const newCallsThisPass = toolCallCount - passStartCallCount;

      if (pass === 0) {
        config.logger?.info?.(`[memory ETL] Pass 1: ${newCallsThisPass} tool calls`);
      }

      // If we extracted enough or made no progress, stop
      if (toolCallCount >= MIN_TOOL_CALLS) break;
      if (newCallsThisPass === 0) {
        if (pass === 0) {
          // First pass with zero calls — nothing worth extracting
          break;
        }
        break;
      }

      // Ask the model to continue extracting — include conversation for context
      const remaining = MIN_TOOL_CALLS - toolCallCount;
      const alreadyExtracted = extractedSummaries.size > 0
        ? `\nALREADY EXTRACTED (DO NOT REPEAT):\n${Array.from(extractedSummaries).map(s => `- "${s}"`).join("\n")}\n` +
          (userProfileUpdated ? `- user profile (already updated)\n` : "")
        : "";
      currentMessages = [
        userMessage(
          `=== ORIGINAL CONVERSATION (re-read carefully) ===\n\n${conversationText}\n\n` +
          `=== CONTINUE EXTRACTING (pass ${pass + 2}/${MAX_PASSES}) ===\n` +
          `You've extracted ${toolCallCount} items so far. ` +
          `Extract at least ${remaining} more NEW items not in the already-extracted list.` +
          alreadyExtracted +
          `\nFocus on what you MISSED: facts, decisions, lessons, events, ` +
          `user profile changes, repeatable skills. ` +
          `NO text output — ONLY tool calls.`,
        ),
      ];
    } catch (err) {
      config.logger?.error?.(`[memory ETL] Pass ${pass + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  config.logger?.info?.(`[memory ETL] Completed: ${toolCallCount} total tool calls across passes`);
  return success;
}
