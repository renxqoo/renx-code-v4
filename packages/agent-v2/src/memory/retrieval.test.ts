import { describe, expect, it } from "vitest";
import { InMemoryMemoryStore } from "./in-memory-store.js";
import {
  retrieveMemoriesAndSkills,
  trimToTokenBudget,
  formatMemoriesAsMD,
  formatSkillsAsMD,
  formatUserProfileAsMD,
} from "./retrieval.js";
import type { RerankResult } from "./retrieval.js";
import type { MemorySearchResult } from "./store.js";

function emb(values: number[]): number[] {
  return values;
}

function makeMemResult(overrides: Partial<MemorySearchResult> = {}): MemorySearchResult {
  return {
    id: overrides.id ?? "1",
    content: overrides.content ?? "Test memory",
    summary: overrides.summary ?? "test",
    embedding: overrides.embedding ?? [1, 0, 0],
    type: overrides.type ?? "fact",
    importance: overrides.importance ?? 0.5,
    accessCount: overrides.accessCount ?? 0,
    createdAt: overrides.createdAt ?? new Date(),
    lastAccessed: overrides.lastAccessed ?? new Date(),
    similarity: overrides.similarity ?? 0.8,
    sessionId: overrides.sessionId,
    runId: overrides.runId,
  };
}

describe("retrieval engine", () => {
  it("retrieves memories and skills from store", async () => {
    const store = new InMemoryMemoryStore();

    await store.storeMemory({
      content: "User uses pnpm workspaces",
      summary: "pnpm",
      embedding: emb([1.0, 0.0, 0.0]),
      type: "fact",
      importance: 0.8,
    });
    await store.upsertProfile({
      key: "skill:pnpm",
      content: "## Debug pnpm\nRun pnpm install.",
      version: 1,
      status: "active",
      embedding: emb([1.0, 0.0, 0.0]),
      metadata: {},
    });

    const result = await retrieveMemoriesAndSkills({
      store,
      embedding: emb([1.0, 0.1, 0.0]),
      memoryTopK: 5,
      skillTopK: 3,
      minSimilarity: 0.5,
    });

    expect(result.memoryMD).toContain("pnpm");
    expect(result.skillMD).toContain("Debug pnpm");
    expect(result.matchedMemories.length).toBeGreaterThan(0);
    expect(result.matchedSkills.length).toBe(1);
  });

  it("returns empty MD when no matches", async () => {
    const store = new InMemoryMemoryStore();
    const result = await retrieveMemoriesAndSkills({
      store,
      embedding: emb([1.0, 0.0, 0.0]),
      memoryTopK: 5,
      skillTopK: 3,
      minSimilarity: 0.9,
    });

    expect(result.memoryMD).toBe("");
    expect(result.skillMD).toBe("");
    expect(result.matchedMemories).toHaveLength(0);
  });
});

describe("MD formatters", () => {
  it("formats memories as MD list", () => {
    const results: RerankResult[] = [
      { ...makeMemResult({ content: "Memory A", type: "fact" }), score: 0.9 },
      { ...makeMemResult({ content: "Memory B", type: "decision" }), score: 0.7 },
    ];

    const md = formatMemoriesAsMD(results);
    expect(md).toContain("Memory A");
    expect(md).toContain("Memory B");
    expect(md).toContain("[fact]");
    expect(md).toContain("[decision]");
    expect(md).toContain("relevance: 0.90");
  });

  it("formats empty memories as empty string", () => {
    expect(formatMemoriesAsMD([])).toBe("");
  });

  it("formats skills as MD", () => {
    const skills = [
      {
        key: "skill:1",
        content: "## Skill 1\nHow to do X",
        version: 1,
        status: "active" as const,
        metadata: {},
        updatedAt: new Date(),
      },
    ];
    const md = formatSkillsAsMD(skills);
    expect(md).toContain("## Skill 1");
  });

  it("formats user profile as MD", () => {
    const profile = {
      key: "user:default",
      content: "## Expertise\n- TypeScript",
      version: 1,
      status: "active" as const,
      metadata: {},
      updatedAt: new Date(),
    };
    const md = formatUserProfileAsMD(profile);
    expect(md).toContain("## User Profile");
    expect(md).toContain("TypeScript");
  });

  it("returns empty for null user profile", () => {
    expect(formatUserProfileAsMD(null)).toBe("");
  });
});

describe("token budget trimming", () => {
  it("keeps results within budget", () => {
    const results: RerankResult[] = [
      { ...makeMemResult({ content: "Short" }), score: 0.9 },
      { ...makeMemResult({ content: "This is a much longer piece of text that will consume more tokens" }), score: 0.8 },
    ];

    // Budget of 50: "Short" entry = ceil(5/4)+10 = 12 + 20 overhead = 32. Fits one.
    const trimmed = trimToTokenBudget(results, 50);
    expect(trimmed.length).toBe(1);
    expect(trimmed[0].content).toBe("Short");
  });

  it("returns empty for zero budget", () => {
    const results: RerankResult[] = [
      { ...makeMemResult({ content: "A" }), score: 0.9 },
    ];
    expect(trimToTokenBudget(results, 0)).toHaveLength(0);
  });
});
