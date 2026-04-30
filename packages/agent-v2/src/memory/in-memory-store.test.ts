import { describe, expect, it } from "vitest";
import { InMemoryMemoryStore } from "./in-memory-store.js";

function makeEmbedding(values: number[]): number[] {
  return values;
}

describe("InMemoryMemoryStore", () => {
  const store = new InMemoryMemoryStore();

  it("stores and retrieves a profile", async () => {
    const p = await store.upsertProfile({
      key: "soul",
      content: "# Soul\nYou are helpful.",
      version: 1,
      status: "active",
      metadata: {},
    });
    expect(p.key).toBe("soul");
    expect(p.content).toBe("# Soul\nYou are helpful.");
    expect(p.version).toBe(1);

    const got = await store.getProfile("soul");
    expect(got?.content).toBe("# Soul\nYou are helpful.");
  });

  it("upserts profile increments version", async () => {
    await store.upsertProfile({ key: "u1", content: "v1", version: 1, status: "active", metadata: {} });
    const u2 = await store.upsertProfile({ key: "u1", content: "v2", version: 1, status: "active", metadata: {} });
    expect(u2.version).toBe(2);
    expect(u2.content).toBe("v2");
  });

  it("returns null for missing profile", async () => {
    const got = await store.getProfile("nonexistent");
    expect(got).toBeNull();
  });

  it("stores memory with auto-generated id", async () => {
    const m = await store.storeMemory({
      content: "User prefers TypeScript",
      summary: "TypeScript preference",
      embedding: makeEmbedding([0.1, 0.2, 0.3]),
      type: "fact",
      importance: 0.8,
    });
    expect(m.id).toBeTruthy();
    expect(m.content).toBe("User prefers TypeScript");
    expect(m.accessCount).toBe(0);
  });

  it("searches memories by vector similarity", async () => {
    const store = new InMemoryMemoryStore();
    await store.storeMemory({
      content: "Project uses pnpm",
      summary: "pnpm usage",
      embedding: makeEmbedding([1.0, 0.0, 0.0]),
      type: "fact",
      importance: 0.5,
    });
    await store.storeMemory({
      content: "User likes Rust",
      summary: "Rust interest",
      embedding: makeEmbedding([0.0, 1.0, 0.0]),
      type: "fact",
      importance: 0.5,
    });

    const results = await store.searchMemories({
      embedding: makeEmbedding([1.0, 0.1, 0.0]),
      topK: 2,
    });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toBe("Project uses pnpm");
  });

  it("filters search by memory type", async () => {
    const store = new InMemoryMemoryStore();
    await store.storeMemory({
      content: "Fact about code",
      summary: "code fact",
      embedding: makeEmbedding([1.0, 0.0, 0.0]),
      type: "fact",
      importance: 0.5,
    });
    await store.storeMemory({
      content: "User decided on vitest",
      summary: "vitest decision",
      embedding: makeEmbedding([1.0, 0.1, 0.0]),
      type: "decision",
      importance: 0.5,
    });

    const results = await store.searchMemories({
      embedding: makeEmbedding([1.0, 0.0, 0.0]),
      topK: 5,
      types: ["decision"],
    });
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("decision");
  });

  it("respects minSimilarity threshold", async () => {
    const store = new InMemoryMemoryStore();
    await store.storeMemory({
      content: "Some fact",
      summary: "fact",
      embedding: makeEmbedding([1.0, 0.0, 0.0]),
      type: "fact",
      importance: 0.5,
    });

    const results = await store.searchMemories({
      embedding: makeEmbedding([0.0, 1.0, 0.0]),
      topK: 5,
      minSimilarity: 0.9,
    });
    expect(results.length).toBe(0);
  });

  it("touches memories increments access count", async () => {
    const store = new InMemoryMemoryStore();
    const m = await store.storeMemory({
      content: "Some fact",
      summary: "fact",
      embedding: makeEmbedding([1.0, 0.0, 0.0]),
      type: "fact",
      importance: 0.5,
    });

    await store.touchMemories([m.id]);
    const results = await store.searchMemories({
      embedding: makeEmbedding([1.0, 0.0, 0.0]),
      topK: 1,
    });
    expect(results[0].accessCount).toBe(1);
  });

  it("graph neighbors: finds memories sharing entities", async () => {
    const store = new InMemoryMemoryStore();
    const m1 = await store.storeMemory({
      content: "Memory about React",
      summary: "React",
      embedding: makeEmbedding([1.0, 0.0, 0.0]),
      type: "fact",
      importance: 0.5,
    });
    const m2 = await store.storeMemory({
      content: "Memory about Hooks",
      summary: "Hooks",
      embedding: makeEmbedding([0.0, 1.0, 0.0]),
      type: "fact",
      importance: 0.5,
    });

    await store.upsertEntity({ id: "react", name: "React", type: "tool", properties: {} });
    await store.linkMemoryEntities(m1.id, ["react"]);
    await store.linkMemoryEntities(m2.id, ["react"]);

    const neighbors = await store.getGraphNeighbors([m1.id]);
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0].id).toBe(m2.id);
  });

  it("searches skills by vector similarity", async () => {
    const store = new InMemoryMemoryStore();
    await store.upsertProfile({
      key: "skill:debug-pnpm",
      content: "## How to debug pnpm issues\n\nRun pnpm install.",
      version: 1,
      status: "active",
      embedding: makeEmbedding([1.0, 0.0, 0.0]),
      metadata: { successRate: 0.8 },
    });
    await store.upsertProfile({
      key: "skill:other",
      content: "## Other skill",
      version: 1,
      status: "pending",
      embedding: makeEmbedding([1.0, 0.0, 0.0]),
      metadata: {},
    });

    const results = await store.searchSkills({
      embedding: makeEmbedding([1.0, 0.0, 0.0]),
      topK: 5,
    });
    expect(results).toHaveLength(1);
    expect(results[0].key).toBe("skill:debug-pnpm");
  });

  it("upserts entities merges properties", async () => {
    const store = new InMemoryMemoryStore();
    await store.upsertEntity({ id: "react", name: "React", type: "tool", properties: { version: "18" } });
    await store.upsertEntity({ id: "react", name: "React.js", type: "tool", properties: { license: "MIT" } });

    // We don't expose a getEntity method, so test indirectly via linking
    // Just verify no error
    await store.upsertRelation({ fromEntity: "react", toEntity: "typescript", type: "uses", weight: 1.0 });
  });
});
