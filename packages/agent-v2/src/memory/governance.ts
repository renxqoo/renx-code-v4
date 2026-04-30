/**
 * Memory Governance — background maintenance utilities.
 *
 * These functions are designed to run periodically (e.g., via a cron job
 * or scheduled task) — NOT during the agent request/response cycle.
 * They are pure async functions that operate on the MemoryStore interface
 * and work with any backend (InMemory, PgVector, etc.).
 */
import type { MemoryStore, Memory, MemoryType } from "./store.js";
import type { LLMClient } from "../llm-client.js";
import { userMessage } from "../message.js";

// ── Cosine Similarity ────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Forgetting ───────────────────────────────────────

export type CleanupOptions = {
  /** Score threshold below which memories are removed. Default 0.05. */
  scoreThreshold?: number;
  /** Decay half-life in milliseconds. Default 30 days. */
  halfLifeMs?: number;
  /** How to handle removed memories. "delete" (default) or "archive". */
  action?: "delete" | "archive";
  /** If true, logs which memories would be removed without actually removing. */
  dryRun?: boolean;
};

/**
 * Calculate the forgetting score for a memory.
 * score = importance × recencyDecay × normalizedAccessCount
 *
 * recencyDecay uses exponential decay: 0.5^(ageMs / halfLifeMs)
 * normalizedAccessCount: min(1, accessCount / 10) — caps at 1 after 10 accesses
 */
function forgettingScore(
  memory: Memory,
  halfLifeMs: number,
  now: number,
): number {
  const ageMs = now - memory.lastAccessed.getTime();
  const recencyDecay = Math.pow(0.5, ageMs / halfLifeMs);
  const normalizedAccess = Math.min(1, memory.accessCount / 10);
  return memory.importance * recencyDecay * normalizedAccess;
}

/**
 * Remove low-value memories based on the forgetting formula:
 * score = importance × 0.5^(age/halfLife) × min(1, accessCount/10)
 */
export async function cleanupMemories(
  store: MemoryStore,
  opts: CleanupOptions = {},
): Promise<{ removed: number; kept: number; removedIds: string[] }> {
  const {
    scoreThreshold = 0.05,
    halfLifeMs = 30 * 24 * 60 * 60 * 1000,
    action = "delete",
    dryRun = false,
  } = opts;

  const now = Date.now();
  const toRemove: Memory[] = [];
  const toKeep: Memory[] = [];

  // Fetch memories in batches to handle large datasets
  let offset = 0;
  const batchSize = 500;
  let hasMore = true;

  while (hasMore) {
    const batch = await store.listMemories({ limit: batchSize, offset });
    hasMore = batch.length === batchSize;
    offset += batchSize;

    for (const m of batch) {
      const score = forgettingScore(m, halfLifeMs, now);
      if (score < scoreThreshold) {
        toRemove.push(m);
      } else {
        toKeep.push(m);
      }
    }
  }

  const removedIds: string[] = [];

  if (!dryRun) {
    for (const m of toRemove) {
      if (action === "archive") {
        // Archive: set importance to 0 (marks for review without deleting)
        await store.updateMemoryImportance(m.id, 0);
      } else {
        await store.deleteMemory(m.id);
      }
      removedIds.push(m.id);
    }
  } else {
    removedIds.push(...toRemove.map((m) => m.id));
  }

  if (dryRun && toRemove.length > 0) {
    console.log(
      `[governance] cleanupMemories (dryRun): would remove ${toRemove.length}, keep ${toKeep.length}`,
    );
  }

  return { removed: toRemove.length, kept: toKeep.length, removedIds };
}

// ── Merging ──────────────────────────────────────────

export type MergeOptions = {
  /** Cosine similarity threshold for merging. Default 0.9. */
  similarityThreshold?: number;
  /** Optional: limit merging to memories linked to a specific entity. */
  entityId?: string;
  /** LLM client for generating merged memory content. */
  llmClient: LLMClient;
  /** Model for merge summarization. */
  model: string;
  /** If true, logs merge candidates without actually merging. */
  dryRun?: boolean;
};

/**
 * Find and merge near-duplicate memories on the same entities.
 *
 * For each entity, finds memories with pairwise cosine similarity above the
 * threshold, then calls the LLM to produce a single merged memory that
 * preserves all key information from the originals.
 */
export async function mergeSimilarMemories(
  store: MemoryStore,
  opts: MergeOptions,
): Promise<{ merged: number; mergedIds: string[] }> {
  const {
    similarityThreshold = 0.9,
    entityId,
    llmClient,
    model,
    dryRun = false,
  } = opts;

  const mergedIds: string[] = [];

  // Fetch memories (optionally filtered by entity)
  let offset = 0;
  const batchSize = 500;
  const allMemories: Memory[] = [];

  while (true) {
    const batch = await store.listMemories(
      entityId ? { entityId, limit: batchSize, offset } : { limit: batchSize, offset },
    );
    if (batch.length === 0) break;
    allMemories.push(...batch);
    offset += batchSize;
    if (batch.length < batchSize) break;
  }

  if (allMemories.length < 2) {
    return { merged: 0, mergedIds: [] };
  }

  // Find similar pairs
  type MergeCandidate = { a: Memory; b: Memory; similarity: number };
  const candidates: MergeCandidate[] = [];

  for (let i = 0; i < allMemories.length; i++) {
    for (let j = i + 1; j < allMemories.length; j++) {
      const sim = cosineSimilarity(allMemories[i].embedding, allMemories[j].embedding);
      if (sim >= similarityThreshold) {
        candidates.push({ a: allMemories[i], b: allMemories[j], similarity: sim });
      }
    }
  }

  if (candidates.length === 0) {
    return { merged: 0, mergedIds: [] };
  }

  // Group overlapping candidates (transitive closure)
  const merged = new Set<string>();
  const groups: Memory[][] = [];

  for (const { a, b } of candidates) {
    if (merged.has(a.id) || merged.has(b.id)) continue;

    // Find all memories that are similar to this pair
    const group = [a, b];
    merged.add(a.id);
    merged.add(b.id);

    groups.push(group);
  }

  let mergedCountFinal = 0;

  if (!dryRun && groups.length > 0) {
    for (const group of groups) {
      try {
        const mergedContent = await llmMergeMemories(llmClient, model, group);
        if (!mergedContent) continue;

        // Determine merged properties
        const highestImportance = Math.max(...group.map((m) => m.importance));
        const totalAccess = group.reduce((sum, m) => sum + m.accessCount, 0);
        const avgEmbedding = averageEmbedding(group.map((m) => m.embedding));
        const types = new Set(group.map((m) => m.type));
        // Prefer fact, then lesson, then decision, then event
        const typePriority: MemoryType[] = ["fact", "lesson", "decision", "event"];
        const mergedType = typePriority.find((t) => types.has(t)) ?? group[0].type;

        // Delete originals
        for (const m of group) {
          await store.deleteMemory(m.id);
          mergedIds.push(m.id);
        }

        // Insert merged memory
        const mergedMem = await store.storeMemory({
          content: mergedContent,
          summary: mergedContent.slice(0, 50),
          embedding: avgEmbedding,
          type: mergedType,
          importance: highestImportance,
          sessionId: group[0].sessionId,
          runId: group[0].runId,
        });

        // Link merged memory to all entities of originals
        const entityIds = new Set<string>();
        for (const m of group) {
          const entities = await store.getEntitiesForMemory(m.id);
          for (const e of entities) entityIds.add(e.id);
        }
        if (entityIds.size > 0) {
          await store.linkMemoryEntities(mergedMem.id, [...entityIds]);
        }

        // Touch the new memory with accumulated access count
        if (totalAccess > 0) {
          await store.touchMemories([mergedMem.id]);
        }

        mergedCountFinal++;
      } catch {
        // Skip merge failures — don't delete originals if merge failed
      }
    }
  }

  if (dryRun && groups.length > 0) {
    console.log(
      `[governance] mergeSimilarMemories (dryRun): found ${groups.length} merge candidate groups`,
    );
  }

  return { merged: dryRun ? 0 : mergedCountFinal, mergedIds };
}

async function llmMergeMemories(
  llmClient: LLMClient,
  model: string,
  memories: Memory[],
): Promise<string | null> {
  const contentList = memories
    .map((m, i) => `${i + 1}. [${m.type}] ${m.content}`)
    .join("\n");

  const systemPrompt =
    "Merge the following related memories into a single concise memory statement. " +
    "Preserve all key facts, decisions, and insights. Output ONLY the merged statement — no prefixes, no JSON.";

  const textParts: string[] = [];
  const gen = llmClient.stream({
    model,
    systemPrompt,
    messages: [userMessage(contentList)],
    maxTokens: 300,
  });

  for await (const chunk of gen) {
    if (chunk.type === "text-delta") textParts.push(chunk.delta);
    else if (chunk.type === "error") return null;
  }

  return textParts.join("").trim() || null;
}

function averageEmbedding(embeddings: number[][]): number[] {
  if (embeddings.length === 0) return [];
  const dim = embeddings[0].length;
  const result = new Array(dim).fill(0);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) {
      result[i] += emb[i];
    }
  }
  for (let i = 0; i < dim; i++) {
    result[i] /= embeddings.length;
  }
  return result;
}

// ── Conflict Detection ───────────────────────────────

export type ConflictResult = {
  hasConflict: boolean;
  conflictingIds: string[];
  /** Human-readable summary of the conflict, if any. */
  summary?: string;
};

/**
 * Detect if a newly stored memory contradicts existing memories on the same entities.
 *
 * Strategy: find all memories sharing entities with the new memory, compute
 * cosine similarity with embedding (high similarity + opposite sentiment = conflict),
 * then use the LLM to evaluate whether the content actually contradicts.
 */
export async function detectConflicts(
  store: MemoryStore,
  newMemoryId: string,
  llmClient: LLMClient,
  model: string,
): Promise<ConflictResult> {
  // Find the new memory by scanning the store
  let newMemory: Memory | null = null;
  const batch = await store.listMemories({ limit: 1000 });
  newMemory = batch.find((m) => m.id === newMemoryId) ?? null;

  if (!newMemory) {
    return { hasConflict: false, conflictingIds: [] };
  }

  // Get entities linked to this memory
  const entities = await store.getEntitiesForMemory(newMemory.id);
  if (entities.length === 0) {
    return { hasConflict: false, conflictingIds: [] };
  }

  // Find candidate conflicting memories (same entities, high similarity, different content)
  const candidates = new Map<string, Memory>();
  for (const entity of entities) {
    const linked = await store.listMemories({
      entityId: entity.id,
      limit: 50,
    });

    for (const m of linked) {
      if (m.id === newMemory.id) continue;
      if (candidates.has(m.id)) continue;

      // Quick pre-filter: high embedding similarity means potentially contradictory
      if (newMemory.embedding.length > 0 && m.embedding.length > 0) {
        const sim = cosineSimilarity(newMemory.embedding, m.embedding);
        if (sim < 0.7) continue; // Not similar enough to be contradictory
      }

      candidates.set(m.id, m);
    }
  }

  if (candidates.size === 0) {
    return { hasConflict: false, conflictingIds: [] };
  }

  // Use LLM to evaluate each candidate for contradiction
  const conflictingIds: string[] = [];
  const conflictSummaries: string[] = [];

  for (const candidate of candidates.values()) {
    try {
      const result = await llmEvaluateConflict(llmClient, model, newMemory, candidate);
      if (result.isConflict) {
        conflictingIds.push(candidate.id);
        if (result.summary) conflictSummaries.push(result.summary);
      }
    } catch {
      // Skip evaluation failures
    }
  }

  return {
    hasConflict: conflictingIds.length > 0,
    conflictingIds,
    summary: conflictSummaries.length > 0 ? conflictSummaries.join("; ") : undefined,
  };
}

async function llmEvaluateConflict(
  llmClient: LLMClient,
  model: string,
  newMemory: Memory,
  existing: Memory,
): Promise<{ isConflict: boolean; summary?: string }> {
  const systemPrompt = [
    "You are a contradiction detector. Compare two memories and determine if they directly contradict each other.",
    "",
    "Contradiction means:",
    "- One states a fact and the other states the opposite",
    "- One describes a decision and the other describes an incompatible decision",
    "- They make mutually exclusive claims about the same subject",
    "",
    "Not a contradiction:",
    "- Temporal changes (was X, now Y)",
    "- Different but compatible facts about the same entity",
    "- Same fact expressed differently",
    "",
    "Respond with ONLY: YES or NO",
    "If YES, append a one-line summary after a colon: YES: <summary>",
  ].join("\n");

  const prompt = [
    `Memory A (new): [${newMemory.type}] ${newMemory.content}`,
    `Memory B (existing): [${existing.type}] ${existing.content}`,
  ].join("\n\n");

  const textParts: string[] = [];
  const gen = llmClient.stream({
    model,
    systemPrompt,
    messages: [userMessage(prompt)],
    maxTokens: 100,
  });

  for await (const chunk of gen) {
    if (chunk.type === "text-delta") textParts.push(chunk.delta);
    else if (chunk.type === "error") return { isConflict: false };
  }

  const response = textParts.join("").trim().toUpperCase();
  if (response.startsWith("YES")) {
    const summary = response.includes(":") ? response.slice(response.indexOf(":") + 1).trim() : undefined;
    return { isConflict: true, summary };
  }

  return { isConflict: false };
}
