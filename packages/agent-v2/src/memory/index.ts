export type {
  MemoryStore, Memory, MemorySearchResult, MemoryType,
  Entity, Relation, Profile, ProfileKey, EmbeddingClient, MemoryLogger,
} from "./store.js";
export { InMemoryMemoryStore, type InMemoryStoreConfig } from "./in-memory-store.js";
export { createPgVectorMemoryStore, type PgPool, type PgVectorStoreConfig } from "./pgvector-store.js";
export {
  retrieveMemoriesAndSkills, formatMemoriesAsMD, formatSkillsAsMD,
  formatUserProfileAsMD, trimToTokenBudget,
  type RetrievalResult, type RetrievalOptions, type RerankResult,
  type RerankOptions, type FormattedMemory,
} from "./retrieval.js";
export { runMemoryExtraction, type ExtractionConfig } from "./etl.js";
export {
  cleanupMemories, mergeSimilarMemories, detectConflicts,
  type CleanupOptions, type MergeOptions, type ConflictResult,
} from "./governance.js";
