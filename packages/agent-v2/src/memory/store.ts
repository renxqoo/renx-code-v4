// ── Memory Types ──────────────────────────────────────

export type MemoryType = "fact" | "decision" | "event" | "lesson";

export type Memory = {
  id: string;
  content: string;
  summary: string;
  embedding: number[];
  type: MemoryType;
  importance: number;
  accessCount: number;
  createdAt: Date;
  lastAccessed: Date;
  sessionId?: string;
  runId?: string;
};

export type MemorySearchResult = Memory & {
  similarity: number;
};

export type Entity = {
  id: string;
  name: string;
  type: "project" | "tool" | "concept" | "person" | "skill";
  properties: Record<string, unknown>;
};

export type Relation = {
  fromEntity: string;
  toEntity: string;
  type: string;
  weight: number;
};

export type ProfileKey = "soul" | `user:${string}` | `skill:${string}`;

export type Profile = {
  key: string;
  content: string;
  version: number;
  status: "active" | "pending" | "archived";
  embedding?: number[];
  metadata: Record<string, unknown>;
  updatedAt: Date;
};

// ── Embedding Client ─────────────────────────────────

export type EmbeddingClient = {
  generateEmbedding(options: {
    model: string;
    input: string | string[];
  }): Promise<{ embeddings: number[][] }>;
};

// ── Logger ───────────────────────────────────────────

export type MemoryLogger = {
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  info?(message: string, ...args: unknown[]): void;
};

// ── Interface ─────────────────────────────────────────

export type MemoryStore = {
  // --- Retrieval ---
  searchMemories(params: {
    embedding: number[];
    topK: number;
    minSimilarity?: number;
    types?: MemoryType[];
    sessionId?: string;
    runId?: string;
    createdAfter?: Date;
    createdBefore?: Date;
  }): Promise<MemorySearchResult[]>;

  getGraphNeighbors(memoryIds: string[]): Promise<MemorySearchResult[]>;

  searchSkills(params: {
    embedding: number[];
    topK: number;
    minSimilarity?: number;
  }): Promise<Profile[]>;

  // --- Storage ---
  storeMemory(
    memory: Omit<Memory, "id" | "createdAt" | "lastAccessed" | "accessCount">,
  ): Promise<Memory>;

  touchMemories(memoryIds: string[]): Promise<void>;

  updateMemoryImportance(id: string, importance: number): Promise<void>;

  deleteMemory(id: string): Promise<void>;

  // --- Profiles ---
  getProfile(key: string): Promise<Profile | null>;

  upsertProfile(profile: Omit<Profile, "updatedAt">): Promise<Profile>;

  deleteProfile(key: string): Promise<void>;

  // --- Entity Graph ---
  upsertEntity(entity: Entity): Promise<Entity>;

  upsertRelation(relation: Relation): Promise<Relation>;

  linkMemoryEntities(memoryId: string, entityIds: string[]): Promise<void>;

  getEntity(id: string): Promise<Entity | null>;

  getEntitiesForMemory(memoryId: string): Promise<Entity[]>;

  getRelationsForEntity(entityId: string): Promise<Relation[]>;

  // --- Skill Lifecycle ---
  recordSkillUse(skillKey: string): Promise<{
    newUseCount: number;
    promotedToActive: boolean;
  }>;

  // --- Listing (for governance) ---
  listMemories(params: {
    entityId?: string;
    types?: MemoryType[];
    minImportance?: number;
    maxImportance?: number;
    limit?: number;
    offset?: number;
  }): Promise<Memory[]>;
};
