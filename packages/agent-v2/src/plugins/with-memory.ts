/**
 * withMemory Plugin — four-layer memory system.
 *
 * Pre-agent: retrieves Soul, User Profile, relevant Memories, and Skills,
 *            and injects them as MD into the system prompt.
 * During:    passes through all agent events.
 * Post-agent: fire-and-forget ETL extraction.
 */
import type { Plugin } from "../plugin.js";
import type { AgentInput, AgentGenerator } from "../types.js";
import type { LLMClient } from "../llm-client.js";
import { getDefaultLLMClient } from "../llm-client.js";
import type { MemoryStore, Profile, MemorySearchResult, EmbeddingClient } from "../memory/store.js";
import { retrieveMemoriesAndSkills } from "../memory/retrieval.js";
import { runMemoryExtraction } from "../memory/etl.js";

export type { EmbeddingClient };

// ── Plugin Options ──────────────────────────────────

export type WithMemoryOptions = {
  store: MemoryStore;
  embeddingClient: EmbeddingClient;
  embeddingModel: string;
  userId?: string;
  etlModel?: string;
  memoryTopK?: number;
  skillTopK?: number;
  minSimilarity?: number;
  memoryTokenBudget?: number;
  skillTokenBudget?: number;
};

// ── Helpers ─────────────────────────────────────────

function extractUserQuery(messages: AgentInput["messages"]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      if (typeof msg.content === "string") return msg.content;
      const textBlock = msg.content.find((b) => b.type === "text");
      if (textBlock && "text" in textBlock) return textBlock.text;
    }
  }
  return null;
}

function getLLMClient(input: AgentInput): LLMClient | null {
  if (input.llmClient) return input.llmClient;
  try {
    return getDefaultLLMClient();
  } catch {
    return null;
  }
}

async function getEmbedding(
  client: EmbeddingClient,
  model: string,
  text: string,
): Promise<number[]> {
  const result = await client.generateEmbedding({ model, input: text });
  const emb = result.embeddings[0];
  if (!emb || emb.length === 0) {
    throw new Error(`Embedding API returned empty result for model "${model}"`);
  }
  return emb;
}

// ── Plugin ──────────────────────────────────────────

export function withMemory(opts: WithMemoryOptions): Plugin {
  const {
    store,
    embeddingClient,
    embeddingModel,
    userId = "default",
    etlModel,
    memoryTopK = 5,
    skillTopK = 3,
    minSimilarity = 0.7,
    memoryTokenBudget = 800,
    skillTokenBudget = 400,
  } = opts;

  return (inner) =>
    async function* (input: AgentInput): AgentGenerator {
      // ── Pre-agent: Retrieve + inject ────────────
      let memoryMD = "";
      let skillMD = "";
      let matchedMemories: MemorySearchResult[] = [];
      let matchedSkills: Profile[] = [];

      const [userQuery, userProfile, soulProfile] = await Promise.all([
        Promise.resolve(extractUserQuery(input.messages)),
        store.getProfile(`user:${userId}`),
        store.getProfile("soul"),
      ]);

      if (userQuery) {
        try {
          const queryEmbedding = await getEmbedding(
            embeddingClient,
            embeddingModel,
            userQuery,
          );

          if (queryEmbedding.length > 0) {
            const retrieval = await retrieveMemoriesAndSkills({
              store,
              embedding: queryEmbedding,
              memoryTopK,
              skillTopK,
              minSimilarity,
              memoryTokenBudget,
              skillTokenBudget,
            });

            memoryMD = retrieval.memoryMD;
            skillMD = retrieval.skillMD;
            matchedMemories = retrieval.matchedMemories;
            matchedSkills = retrieval.matchedSkills;
          }
        } catch (err) {
          // Pre-agent retrieval failure is non-fatal — proceed without memory
          console.error(
            "[withMemory] Pre-agent retrieval failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      const sections: string[] = [];
      if (soulProfile?.content) {
        sections.push(soulProfile.content);
      }
      if (userProfile?.content) {
        sections.push(`## User Profile\n\n${userProfile.content}`);
      }
      if (memoryMD) {
        sections.push(memoryMD);
      }
      if (skillMD) {
        sections.push(skillMD);
      }

      const augmentedInput: AgentInput = {
        ...input,
        systemPrompt:
          sections.length > 0
            ? [input.systemPrompt, ...sections].join("\n\n")
            : input.systemPrompt,
      };

      // ── During-agent: Pass through, capture outcome ──
      let runId = "";
      let allMessages: import("../message.js").Message[] = [];

      const gen = inner(augmentedInput);
      for await (const event of gen) {
        if (event.type === "run:finished") {
          runId = event.outcome.runId;
          allMessages = event.outcome.messages;
        }
        yield event;
      }

      // ── Post-agent: Fire-and-forget ETL ────────
      if (allMessages.length > 0) {
        const llm = getLLMClient(input);
        if (llm) {
          scheduleETL({
            messages: allMessages,
            store,
            embeddingClient,
            embeddingModel,
            etlModel: etlModel ?? input.model,
            llmClient: llm,
            userProfile,
            soulProfile,
            userId,
            runId,
            matchedMemories,
            matchedSkills,
          });
        }
      }
    };
}

// ── Post-agent ETL ──────────────────────────────────

function scheduleETL(params: {
  messages: import("../message.js").Message[];
  store: MemoryStore;
  embeddingClient: EmbeddingClient;
  embeddingModel: string;
  etlModel: string;
  llmClient: LLMClient;
  userProfile: Profile | null;
  soulProfile: Profile | null;
  userId: string;
  runId: string;
  matchedMemories: MemorySearchResult[];
  matchedSkills: Profile[];
}): void {
  const {
    messages, store, embeddingClient, embeddingModel,
    etlModel, llmClient, userProfile, soulProfile,
    userId, runId, matchedMemories, matchedSkills,
  } = params;

  // Fire-and-forget: don't block the agent stream
  Promise.resolve().then(async () => {
    try {
      await runMemoryExtraction({
        config: {
          llmClient,
          model: etlModel,
          store,
          embeddingClient,
          embeddingModel,
          userId,
          runId,
        },
        messages,
        userProfile,
        soulProfile,
      });

      // Touch matched memories after successful extraction
      if (matchedMemories.length > 0) {
        await store.touchMemories(matchedMemories.map((m) => m.id));
      }

      // Track skill usage and promote pending → active when threshold met
      for (const skill of matchedSkills) {
        try {
          const result = await store.recordSkillUse(skill.key);
          if (result.promotedToActive) {
            console.log(`[withMemory] Skill promoted to active: ${skill.key} (used ${result.newUseCount} times)`);
          }
        } catch {
          // Non-fatal: skill tracking failure doesn't affect the conversation
        }
      }
    } catch (err) {
      console.error(
        "[withMemory] Post-agent ETL failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  });
}
