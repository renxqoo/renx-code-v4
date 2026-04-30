import type {
  MemoryStore,
  Memory,
  MemorySearchResult,
  MemoryType,
  Entity,
  Relation,
  Profile,
  MemoryLogger,
} from "./store.js";
import { generateId } from "../utils/id.js";

function cosineSimilarity(a: number[], b: number[], logger?: MemoryLogger): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length !== b.length) {
    logger?.warn(
      `[InMemoryStore] Vector dimension mismatch: ${a.length} vs ${b.length}. ` +
      "This indicates a configuration error (different embedding models). Returning 0.",
    );
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

const DEFAULT_LOGGER: MemoryLogger = {
  warn: (msg, ...args) => console.warn(msg, ...args),
  error: (msg, ...args) => console.error(msg, ...args),
};

export type InMemoryStoreConfig = {
  logger?: MemoryLogger;
};

export class InMemoryMemoryStore implements MemoryStore {
  private memories = new Map<string, Memory>();
  private profiles = new Map<string, Profile>();
  private entities = new Map<string, Entity>();
  private relations: Relation[] = [];
  private memoryEntities = new Map<string, Set<string>>();
  private logger: MemoryLogger;

  constructor(config: InMemoryStoreConfig = {}) {
    this.logger = config.logger ?? DEFAULT_LOGGER;
  }

  // ── Retrieval ──────────────────────────────────

  async searchMemories(params: {
    embedding: number[];
    topK: number;
    minSimilarity?: number;
    types?: MemoryType[];
    sessionId?: string;
    runId?: string;
    createdAfter?: Date;
    createdBefore?: Date;
  }): Promise<MemorySearchResult[]> {
    const { embedding, topK, minSimilarity = 0, types, sessionId, runId, createdAfter, createdBefore } = params;
    const results: MemorySearchResult[] = [];

    for (const m of this.memories.values()) {
      if (types && types.length > 0 && !types.includes(m.type)) continue;
      if (sessionId !== undefined && m.sessionId !== sessionId) continue;
      if (runId !== undefined && m.runId !== runId) continue;
      if (createdAfter && m.createdAt < createdAfter) continue;
      if (createdBefore && m.createdAt > createdBefore) continue;

      const similarity = cosineSimilarity(embedding, m.embedding, this.logger);
      if (similarity >= minSimilarity) {
        results.push({ ...m, similarity });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  }

  async getGraphNeighbors(memoryIds: string[]): Promise<MemorySearchResult[]> {
    const seen = new Set(memoryIds);
    const entityIds = new Set<string>();

    for (const mid of memoryIds) {
      const linked = this.memoryEntities.get(mid);
      if (!linked) continue;
      for (const eid of linked) entityIds.add(eid);
    }

    const neighborIds = new Set<string>();
    for (const [mid, linked] of this.memoryEntities) {
      if (seen.has(mid)) continue;
      for (const eid of linked) {
        if (entityIds.has(eid)) {
          neighborIds.add(mid);
          break;
        }
      }
    }

    const results: MemorySearchResult[] = [];
    for (const mid of neighborIds) {
      const m = this.memories.get(mid);
      if (m) {
        results.push({ ...m, similarity: 0.3 });
      }
    }

    return results;
  }

  async searchSkills(params: {
    embedding: number[];
    topK: number;
    minSimilarity?: number;
  }): Promise<Profile[]> {
    const { embedding, topK, minSimilarity = 0 } = params;
    const results: Array<{ profile: Profile; similarity: number }> = [];

    for (const p of this.profiles.values()) {
      if (!p.key.startsWith("skill:")) continue;
      if (!p.embedding) continue;
      if (p.status !== "active") continue;
      const similarity = cosineSimilarity(embedding, p.embedding, this.logger);
      if (similarity >= minSimilarity) {
        results.push({ profile: p, similarity });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK).map((r) => r.profile);
  }

  // ── Storage ────────────────────────────────────

  async storeMemory(
    memory: Omit<Memory, "id" | "createdAt" | "lastAccessed" | "accessCount">,
  ): Promise<Memory> {
    const id = generateId();
    const now = new Date();
    const full: Memory = {
      ...memory,
      id,
      createdAt: now,
      lastAccessed: now,
      accessCount: 0,
    };
    this.memories.set(id, full);
    return full;
  }

  async touchMemories(memoryIds: string[]): Promise<void> {
    const now = new Date();
    for (const mid of memoryIds) {
      const m = this.memories.get(mid);
      if (m) {
        m.accessCount += 1;
        m.lastAccessed = now;
      }
    }
  }

  async updateMemoryImportance(id: string, importance: number): Promise<void> {
    const m = this.memories.get(id);
    if (m) {
      m.importance = Math.max(0, Math.min(1, importance));
    }
  }

  async deleteMemory(id: string): Promise<void> {
    this.memories.delete(id);
    this.memoryEntities.delete(id);
  }

  // ── Profiles ───────────────────────────────────

  async getProfile(key: string): Promise<Profile | null> {
    return this.profiles.get(key) ?? null;
  }

  async upsertProfile(profile: Omit<Profile, "updatedAt">): Promise<Profile> {
    const now = new Date();
    const existing = this.profiles.get(profile.key);
    const full: Profile = {
      ...profile,
      version: (existing?.version ?? 0) + 1,
      updatedAt: now,
    };
    this.profiles.set(profile.key, full);
    return full;
  }

  async deleteProfile(key: string): Promise<void> {
    this.profiles.delete(key);
  }

  // ── Entity Graph ───────────────────────────────

  async upsertEntity(entity: Entity): Promise<Entity> {
    const existing = this.entities.get(entity.id);
    const merged: Entity = existing
      ? { ...existing, ...entity, properties: { ...existing.properties, ...entity.properties } }
      : entity;
    this.entities.set(entity.id, merged);
    return merged;
  }

  async upsertRelation(relation: Relation): Promise<Relation> {
    const idx = this.relations.findIndex(
      (r) => r.fromEntity === relation.fromEntity && r.toEntity === relation.toEntity && r.type === relation.type,
    );
    if (idx >= 0) {
      this.relations[idx] = relation;
    } else {
      this.relations.push(relation);
    }
    return relation;
  }

  async linkMemoryEntities(memoryId: string, entityIds: string[]): Promise<void> {
    let existing = this.memoryEntities.get(memoryId);
    if (!existing) {
      existing = new Set();
      this.memoryEntities.set(memoryId, existing);
    }
    for (const eid of entityIds) {
      existing.add(eid);
    }
  }

  async getEntity(id: string): Promise<Entity | null> {
    return this.entities.get(id) ?? null;
  }

  async getEntitiesForMemory(memoryId: string): Promise<Entity[]> {
    const linked = this.memoryEntities.get(memoryId);
    if (!linked) return [];
    return [...linked].map((eid) => this.entities.get(eid)).filter((e): e is Entity => e != null);
  }

  async getRelationsForEntity(entityId: string): Promise<Relation[]> {
    return this.relations.filter(
      (r) => r.fromEntity === entityId || r.toEntity === entityId,
    );
  }

  // ── Skill Lifecycle ────────────────────────────

  async recordSkillUse(skillKey: string): Promise<{
    newUseCount: number;
    promotedToActive: boolean;
  }> {
    const p = this.profiles.get(skillKey);
    if (!p) return { newUseCount: 0, promotedToActive: false };

    const useCount = ((p.metadata?.useCount as number) ?? 0) + 1;
    const successRate = p.metadata?.successRate as number ?? 0;
    p.metadata = { ...p.metadata, useCount, successRate };
    p.updatedAt = new Date();

    let promotedToActive = false;
    if (p.status === "pending" && useCount >= 3) {
      p.status = "active";
      promotedToActive = true;
    }

    this.profiles.set(skillKey, p);
    return { newUseCount: useCount, promotedToActive };
  }

  // ── Listing ────────────────────────────────────

  async listMemories(params: {
    entityId?: string;
    types?: MemoryType[];
    minImportance?: number;
    maxImportance?: number;
    limit?: number;
    offset?: number;
  }): Promise<Memory[]> {
    const { entityId, types, minImportance, maxImportance, limit = 100, offset = 0 } = params;

    const candidates = entityId
      ? [...(this.memoryEntities.get(entityId) ?? new Set())]
          .map((mid) => this.memories.get(mid))
          .filter((m): m is Memory => m != null)
      : [...this.memories.values()];

    let filtered = candidates;
    if (types && types.length > 0) {
      filtered = filtered.filter((m) => types.includes(m.type));
    }
    if (minImportance !== undefined) {
      filtered = filtered.filter((m) => m.importance >= minImportance);
    }
    if (maxImportance !== undefined) {
      filtered = filtered.filter((m) => m.importance <= maxImportance);
    }

    return filtered.slice(offset, offset + limit);
  }
}
