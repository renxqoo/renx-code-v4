-- PgVectorMemoryStore - Database Migration
-- Requires: PostgreSQL 14+ with pgvector extension
--
-- Usage:
--   1. CREATE EXTENSION IF NOT EXISTS vector;
--   2. psql -d <db> -f migration.sql

-- ── Memories ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_v2_memories (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content       TEXT NOT NULL CHECK (char_length(content) > 0),
    summary       TEXT NOT NULL CHECK (char_length(summary) > 0),
    embedding     vector(768) NOT NULL,
    type          TEXT NOT NULL CHECK (type IN ('fact', 'decision', 'event', 'lesson')),
    importance    REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
    access_count  INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_accessed TIMESTAMPTZ NOT NULL DEFAULT now(),
    session_id    TEXT,
    run_id        TEXT
);

-- IVFFlat index for vector similarity search.
-- If you prefer HNSW, replace with:
--   CREATE INDEX idx_memories_embedding ON agent_v2_memories
--     USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_memories_embedding ON agent_v2_memories
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_memories_type ON agent_v2_memories (type);
CREATE INDEX IF NOT EXISTS idx_memories_session ON agent_v2_memories (session_id);
CREATE INDEX IF NOT EXISTS idx_memories_run ON agent_v2_memories (run_id);
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON agent_v2_memories (created_at);

-- ── Profiles ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_v2_profiles (
    key         TEXT PRIMARY KEY,
    content     TEXT NOT NULL,
    version     INTEGER NOT NULL DEFAULT 1,
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'archived')),
    embedding   vector(768),
    metadata    JSONB NOT NULL DEFAULT '{}',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- IVFFlat index for vector similarity search on skills.
-- Only indexes skill profiles with embeddings (Soul and User profiles don't have embeddings).
CREATE INDEX IF NOT EXISTS idx_profiles_skill_embedding ON agent_v2_profiles
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50)
  WHERE key LIKE 'skill:%' AND embedding IS NOT NULL;

-- ── Entities ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_v2_entities (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL CHECK (type IN ('project', 'tool', 'concept', 'person', 'skill')),
    properties JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Relations ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_v2_relations (
    from_entity TEXT NOT NULL REFERENCES agent_v2_entities(id) ON DELETE CASCADE,
    to_entity   TEXT NOT NULL REFERENCES agent_v2_entities(id) ON DELETE CASCADE,
    type        TEXT NOT NULL,
    weight      REAL NOT NULL DEFAULT 1.0,
    PRIMARY KEY (from_entity, to_entity, type)
);

CREATE INDEX IF NOT EXISTS idx_relations_from ON agent_v2_relations (from_entity);
CREATE INDEX IF NOT EXISTS idx_relations_to ON agent_v2_relations (to_entity);

-- ── Memory-Entity Links ───────────────────────────────

CREATE TABLE IF NOT EXISTS agent_v2_memory_entities (
    memory_id UUID NOT NULL REFERENCES agent_v2_memories(id) ON DELETE CASCADE,
    entity_id TEXT NOT NULL REFERENCES agent_v2_entities(id) ON DELETE CASCADE,
    PRIMARY KEY (memory_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_entities_entity ON agent_v2_memory_entities (entity_id);
