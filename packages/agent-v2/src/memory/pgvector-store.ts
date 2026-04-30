/**
 * PgVectorMemoryStore — production memory store backed by PostgreSQL + pgvector.
 *
 * Duck-typed pool interface: accepts any object with a { query } method
 * (pg.Pool, postgres.js client, or mock). No runtime dependency on `pg`.
 *
 * ## Schema
 * Run `packages/agent-v2/src/memory/migration.sql` to create the required
 * tables and indexes before using this store.
 *
 * ## Pool lifecycle
 * The caller owns the pool — create it with proper sizing (min 5, max 20
 * is a reasonable starting point) and call `pool.end()` during graceful
 * shutdown. This store never calls pool.connect/release — it uses the
 * pool.query() convenience method which handles connection management
 * internally.
 */
import type {
  MemoryStore,
  Memory,
  MemorySearchResult,
  MemoryType,
  Entity,
  Relation,
  Profile,
} from "./store.js";

export type PgPool = {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
};

export type PgVectorStoreConfig = {
  pool: PgPool;
  tablePrefix?: string;
};

const VALID_PREFIX_RE = /^[a-z][a-z0-9_]*$/;

export function createPgVectorMemoryStore(config: PgVectorStoreConfig): MemoryStore {
  const prefix = config.tablePrefix ?? "agent_v2_";

  if (!VALID_PREFIX_RE.test(prefix)) {
    throw new Error(
      `Invalid tablePrefix: "${prefix}". Must match ${VALID_PREFIX_RE.source}.`,
    );
  }

  const pool = config.pool;
  const t = (name: string): string => `${prefix}${name}`;

  // ── Helpers ────────────────────────────────────

  function toEmbeddingStr(embedding: number[]): string {
    return `[${embedding.join(",")}]`;
  }

  // ── Retrieval ──────────────────────────────────

  async function searchMemories(params: {
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
    const embeddingStr = toEmbeddingStr(embedding);

    const conditions: string[] = ["1 - (embedding <=> $1::vector) >= $2"];
    const queryParams: unknown[] = [embeddingStr, minSimilarity];
    let paramIdx = 3;

    if (types && types.length > 0) {
      conditions.push(`type = ANY($${paramIdx})`);
      queryParams.push(types);
      paramIdx++;
    }
    if (sessionId !== undefined) {
      conditions.push(`session_id = $${paramIdx}`);
      queryParams.push(sessionId);
      paramIdx++;
    }
    if (runId !== undefined) {
      conditions.push(`run_id = $${paramIdx}`);
      queryParams.push(runId);
      paramIdx++;
    }
    if (createdAfter) {
      conditions.push(`created_at >= $${paramIdx}`);
      queryParams.push(createdAfter.toISOString());
      paramIdx++;
    }
    if (createdBefore) {
      conditions.push(`created_at <= $${paramIdx}`);
      queryParams.push(createdBefore.toISOString());
      paramIdx++;
    }

    queryParams.push(topK);

    const sql = `
      SELECT id, content, summary, embedding, type, importance, access_count,
             created_at, last_accessed, session_id, run_id,
             1 - (embedding <=> $1::vector) AS similarity
      FROM ${t("memories")}
      WHERE ${conditions.join(" AND ")}
      ORDER BY similarity DESC
      LIMIT $${paramIdx}
    `;

    const result = await pool.query(sql, queryParams);
    return result.rows.map((row) => mapMemoryResult(row));
  }

  async function getGraphNeighbors(memoryIds: string[]): Promise<MemorySearchResult[]> {
    if (memoryIds.length === 0) return [];

    const sql = `
      SELECT DISTINCT m.id, m.content, m.summary, m.embedding, m.type,
             m.importance, m.access_count, m.created_at, m.last_accessed,
             m.session_id, m.run_id, 0.3 AS similarity
      FROM ${t("memories")} m
      JOIN ${t("memory_entities")} me ON m.id = me.memory_id
      WHERE me.entity_id IN (
        SELECT DISTINCT me2.entity_id
        FROM ${t("memory_entities")} me2
        WHERE me2.memory_id = ANY($1)
      )
      AND m.id != ALL($1)
      LIMIT 50
    `;

    const result = await pool.query(sql, [memoryIds]);
    return result.rows.map((row) => mapMemoryResult(row));
  }

  async function searchSkills(params: {
    embedding: number[];
    topK: number;
    minSimilarity?: number;
  }): Promise<Profile[]> {
    const { embedding, topK, minSimilarity = 0 } = params;
    const embeddingStr = toEmbeddingStr(embedding);

    const sql = `
      SELECT key, content, version, status, embedding, metadata, updated_at,
             1 - (embedding <=> $1::vector) AS similarity
      FROM ${t("profiles")}
      WHERE key LIKE 'skill:%'
        AND status = 'active'
        AND embedding IS NOT NULL
        AND 1 - (embedding <=> $1::vector) >= $2
      ORDER BY similarity DESC
      LIMIT $3
    `;

    const result = await pool.query(sql, [embeddingStr, minSimilarity, topK]);
    return result.rows.map((row) => mapProfileRow(row));
  }

  // ── Storage ────────────────────────────────────

  async function storeMemory(
    memory: Omit<Memory, "id" | "createdAt" | "lastAccessed" | "accessCount">,
  ): Promise<Memory> {
    const now = new Date();
    const embeddingStr = toEmbeddingStr(memory.embedding);

    const sql = `
      INSERT INTO ${t("memories")}
        (content, summary, embedding, type, importance, access_count, created_at, last_accessed, session_id, run_id)
      VALUES ($1, $2, $3::vector, $4, $5, 0, $6, $6, $7, $8)
      RETURNING id, created_at
    `;

    const result = await pool.query(sql, [
      memory.content,
      memory.summary,
      embeddingStr,
      memory.type,
      memory.importance,
      now.toISOString(),
      memory.sessionId ?? null,
      memory.runId ?? null,
    ]);

    const row = result.rows[0] as Record<string, unknown>;
    return {
      ...memory,
      id: row.id as string,
      createdAt: new Date(row.created_at as string),
      lastAccessed: now,
      accessCount: 0,
    };
  }

  async function touchMemories(memoryIds: string[]): Promise<void> {
    if (memoryIds.length === 0) return;
    const sql = `
      UPDATE ${t("memories")}
      SET access_count = access_count + 1, last_accessed = $2
      WHERE id = ANY($1)
    `;
    await pool.query(sql, [memoryIds, new Date().toISOString()]);
  }

  async function updateMemoryImportance(id: string, importance: number): Promise<void> {
    const sql = `
      UPDATE ${t("memories")}
      SET importance = $2
      WHERE id = $1
    `;
    await pool.query(sql, [id, Math.max(0, Math.min(1, importance))]);
  }

  async function deleteMemory(id: string): Promise<void> {
    // Delete links first, then the memory itself
    await pool.query(`DELETE FROM ${t("memory_entities")} WHERE memory_id = $1`, [id]);
    await pool.query(`DELETE FROM ${t("memories")} WHERE id = $1`, [id]);
  }

  // ── Profiles ───────────────────────────────────

  async function getProfile(key: string): Promise<Profile | null> {
    const sql = `
      SELECT key, content, version, status, embedding, metadata, updated_at
      FROM ${t("profiles")}
      WHERE key = $1
    `;
    const result = await pool.query(sql, [key]);
    if (result.rows.length === 0) return null;
    return mapProfileRow(result.rows[0]);
  }

  async function upsertProfile(profile: Omit<Profile, "updatedAt">): Promise<Profile> {
    const now = new Date();
    const embeddingStr = profile.embedding ? toEmbeddingStr(profile.embedding) : null;

    const sql = `
      INSERT INTO ${t("profiles")} AS p (key, content, version, status, embedding, metadata, updated_at)
      VALUES ($1, $2, $3, $4, $5::vector, $6, $7)
      ON CONFLICT (key) DO UPDATE SET
        content = EXCLUDED.content,
        version = p.version + 1,
        status = EXCLUDED.status,
        embedding = COALESCE(EXCLUDED.embedding, p.embedding),
        metadata = EXCLUDED.metadata,
        updated_at = EXCLUDED.updated_at
      RETURNING version, updated_at
    `;

    const result = await pool.query(sql, [
      profile.key,
      profile.content,
      profile.version,
      profile.status,
      embeddingStr,
      JSON.stringify(profile.metadata),
      now.toISOString(),
    ]);

    const row = result.rows[0] as Record<string, unknown>;
    return {
      ...profile,
      version: row.version as number,
      updatedAt: new Date(row.updated_at as string),
    };
  }

  async function deleteProfile(key: string): Promise<void> {
    await pool.query(`DELETE FROM ${t("profiles")} WHERE key = $1`, [key]);
  }

  // ── Entity Graph ───────────────────────────────

  async function upsertEntity(entity: Entity): Promise<Entity> {
    const sql = `
      INSERT INTO ${t("entities")} (id, name, type, properties)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        type = EXCLUDED.type,
        properties = EXCLUDED.properties
      RETURNING id, name, type, properties, created_at
    `;
    const result = await pool.query(sql, [
      entity.id,
      entity.name,
      entity.type,
      JSON.stringify(entity.properties),
    ]);
    const row = result.rows[0] as Record<string, unknown>;
    return {
      id: row.id as string,
      name: row.name as string,
      type: row.type as Entity["type"],
      properties: (row.properties as Record<string, unknown>) ?? {},
    };
  }

  async function upsertRelation(relation: Relation): Promise<Relation> {
    const sql = `
      INSERT INTO ${t("relations")} (from_entity, to_entity, type, weight)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (from_entity, to_entity, type) DO UPDATE SET weight = EXCLUDED.weight
    `;
    await pool.query(sql, [relation.fromEntity, relation.toEntity, relation.type, relation.weight]);
    return relation;
  }

  async function linkMemoryEntities(memoryId: string, entityIds: string[]): Promise<void> {
    if (entityIds.length === 0) return;
    // Single multi-row INSERT to avoid N+1
    const values: string[] = [];
    const params: unknown[] = [];
    for (let i = 0; i < entityIds.length; i++) {
      const base = i * 2;
      values.push(`($${base + 1}, $${base + 2})`);
      params.push(memoryId, entityIds[i]);
    }
    const sql = `
      INSERT INTO ${t("memory_entities")} (memory_id, entity_id)
      VALUES ${values.join(", ")}
      ON CONFLICT DO NOTHING
    `;
    await pool.query(sql, params);
  }

  async function getEntity(id: string): Promise<Entity | null> {
    const result = await pool.query(
      `SELECT id, name, type, properties FROM ${t("entities")} WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0] as Record<string, unknown>;
    return {
      id: row.id as string,
      name: row.name as string,
      type: row.type as Entity["type"],
      properties: (row.properties as Record<string, unknown>) ?? {},
    };
  }

  async function getEntitiesForMemory(memoryId: string): Promise<Entity[]> {
    const sql = `
      SELECT e.id, e.name, e.type, e.properties
      FROM ${t("entities")} e
      JOIN ${t("memory_entities")} me ON e.id = me.entity_id
      WHERE me.memory_id = $1
    `;
    const result = await pool.query(sql, [memoryId]);
    return result.rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: r.id as string,
        name: r.name as string,
        type: r.type as Entity["type"],
        properties: (r.properties as Record<string, unknown>) ?? {},
      };
    });
  }

  async function getRelationsForEntity(entityId: string): Promise<Relation[]> {
    const sql = `
      SELECT from_entity, to_entity, type, weight
      FROM ${t("relations")}
      WHERE from_entity = $1 OR to_entity = $1
    `;
    const result = await pool.query(sql, [entityId]);
    return result.rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        fromEntity: r.from_entity as string,
        toEntity: r.to_entity as string,
        type: r.type as string,
        weight: Number(r.weight),
      };
    });
  }

  // ── Skill Lifecycle ────────────────────────────

  async function recordSkillUse(skillKey: string): Promise<{
    newUseCount: number;
    promotedToActive: boolean;
  }> {
    const sql = `
      UPDATE ${t("profiles")}
      SET metadata = jsonb_set(
            jsonb_set(metadata, '{useCount}', to_jsonb(COALESCE((metadata->>'useCount')::int, 0) + 1)),
            '{successRate}', to_jsonb(COALESCE((metadata->>'successRate')::real, 0))
          ),
          updated_at = now()
      WHERE key = $1
      RETURNING metadata, status
    `;
    const result = await pool.query(sql, [skillKey]);
    if (result.rows.length === 0) return { newUseCount: 0, promotedToActive: false };

    const row = result.rows[0] as Record<string, unknown>;
    const metadata = typeof row.metadata === "string" ? JSON.parse(row.metadata) : (row.metadata as Record<string, unknown>) ?? {};
    const newUseCount = metadata.useCount as number;
    const currentStatus = row.status as string;

    let promotedToActive = false;
    if (currentStatus === "pending" && newUseCount >= 3) {
      await pool.query(
        `UPDATE ${t("profiles")} SET status = 'active', updated_at = now() WHERE key = $1`,
        [skillKey],
      );
      promotedToActive = true;
    }

    return { newUseCount, promotedToActive };
  }

  // ── Listing ────────────────────────────────────

  async function listMemories(params: {
    entityId?: string;
    types?: MemoryType[];
    minImportance?: number;
    maxImportance?: number;
    limit?: number;
    offset?: number;
  }): Promise<Memory[]> {
    const { entityId, types, minImportance, maxImportance, limit = 100, offset = 0 } = params;

    if (entityId) {
      const sql = `
        SELECT m.id, m.content, m.summary, m.embedding, m.type,
               m.importance, m.access_count, m.created_at, m.last_accessed,
               m.session_id, m.run_id
        FROM ${t("memories")} m
        JOIN ${t("memory_entities")} me ON m.id = me.memory_id
        WHERE me.entity_id = $1
        ORDER BY m.created_at DESC
        LIMIT $2 OFFSET $3
      `;
      const result = await pool.query(sql, [entityId, limit, offset]);
      return result.rows.map((row) => mapMemoryRow(row));
    }

    const conditions: string[] = [];
    const queryParams: unknown[] = [];
    let paramIdx = 1;

    if (types && types.length > 0) {
      conditions.push(`type = ANY($${paramIdx})`);
      queryParams.push(types);
      paramIdx++;
    }
    if (minImportance !== undefined) {
      conditions.push(`importance >= $${paramIdx}`);
      queryParams.push(minImportance);
      paramIdx++;
    }
    if (maxImportance !== undefined) {
      conditions.push(`importance <= $${paramIdx}`);
      queryParams.push(maxImportance);
      paramIdx++;
    }

    queryParams.push(limit, offset);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `
      SELECT id, content, summary, embedding, type,
             importance, access_count, created_at, last_accessed,
             session_id, run_id
      FROM ${t("memories")}
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `;
    const result = await pool.query(sql, queryParams);
    return result.rows.map((row) => mapMemoryRow(row));
  }

  function mapMemoryRow(row: unknown): Memory {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      content: r.content as string,
      summary: r.summary as string,
      embedding: parseVector(r.embedding),
      type: r.type as MemoryType,
      importance: Number(r.importance ?? 0.5),
      accessCount: Number(r.access_count ?? 0),
      createdAt: new Date(r.created_at as string),
      lastAccessed: new Date(r.last_accessed as string),
      sessionId: r.session_id as string | undefined,
      runId: r.run_id as string | undefined,
    };
  }

  return {
    searchMemories,
    getGraphNeighbors,
    searchSkills,
    storeMemory,
    touchMemories,
    updateMemoryImportance,
    deleteMemory,
    getProfile,
    upsertProfile,
    deleteProfile,
    upsertEntity,
    upsertRelation,
    linkMemoryEntities,
    getEntity,
    getEntitiesForMemory,
    getRelationsForEntity,
    recordSkillUse,
    listMemories,
  };
}

// ── Row mapping helpers ────────────────────────────

function mapMemoryResult(row: unknown): MemorySearchResult {
  const r = row as Record<string, unknown>;
  return {
    id: r.id as string,
    content: r.content as string,
    summary: r.summary as string,
    embedding: parseVector(r.embedding),
    type: r.type as MemoryType,
    importance: Number(r.importance ?? 0.5),
    accessCount: Number(r.access_count ?? 0),
    createdAt: new Date(r.created_at as string),
    lastAccessed: new Date(r.last_accessed as string),
    sessionId: r.session_id as string | undefined,
    runId: r.run_id as string | undefined,
    similarity: Number(r.similarity ?? 0),
  };
}

function mapProfileRow(row: unknown): Profile {
  const r = row as Record<string, unknown>;
  return {
    key: r.key as string,
    content: r.content as string,
    version: Number(r.version ?? 1),
    status: r.status as Profile["status"],
    embedding: r.embedding ? parseVector(r.embedding) : undefined,
    metadata: typeof r.metadata === "string" ? JSON.parse(r.metadata as string) : (r.metadata as Record<string, unknown>) ?? {},
    updatedAt: new Date(r.updated_at as string),
  };
}

function parseVector(v: unknown): number[] {
  if (Array.isArray(v)) return v as number[];
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as number[];
    } catch {
      return [];
    }
  }
  return [];
}
