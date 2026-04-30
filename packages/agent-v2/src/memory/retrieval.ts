import type { MemoryStore, MemorySearchResult, Profile } from "./store.js";

// ── Reranking ─────────────────────────────────────

export type RerankResult = MemorySearchResult & { score: number };

export type RerankOptions = {
  similarityWeight?: number;
  importanceWeight?: number;
  recencyWeight?: number;
  recencyWindowMs?: number;
};

const DEFAULT_RERANK: Required<RerankOptions> = {
  similarityWeight: 0.5,
  importanceWeight: 0.3,
  recencyWeight: 0.2,
  recencyWindowMs: 30 * 24 * 60 * 60 * 1000, // 30 days
};

function rerank(results: MemorySearchResult[], opts?: RerankOptions): RerankResult[] {
  const { similarityWeight, importanceWeight, recencyWeight, recencyWindowMs } = {
    ...DEFAULT_RERANK,
    ...opts,
  };
  const now = Date.now();

  return results
    .map((r) => {
      const ageMs = now - r.createdAt.getTime();
      const recency = Math.max(0, 1 - ageMs / recencyWindowMs);
      const score = r.similarity * similarityWeight + r.importance * importanceWeight + recency * recencyWeight;
      return { ...r, score };
    })
    .sort((a, b) => b.score - a.score);
}

// ── MD Formatting ────────────────────────────

export type FormattedMemory = {
  content: string;
  type: string;
  score: number;
};

export function formatMemoriesAsMD(results: RerankResult[]): string {
  if (results.length === 0) return "";
  const lines = ["## Relevant Memories"];
  for (const r of results) {
    const typeTag = `[${r.type}]`;
    lines.push(`- ${typeTag} ${r.content} (relevance: ${r.score.toFixed(2)})`);
  }
  return lines.join("\n");
}

export function formatSkillsAsMD(skills: Profile[]): string {
  if (skills.length === 0) return "";
  return skills
    .filter((s) => s.status === "active")
    .map((s) => s.content)
    .join("\n\n");
}

export function formatUserProfileAsMD(profile: Profile | null): string {
  if (!profile?.content) return "";
  return `## User Profile\n\n${profile.content}`;
}

// ── Token Budget ──────────────────────────────

export function trimToTokenBudget(
  results: RerankResult[],
  budgetTokens: number,
  charsPerToken: number = 4,
): RerankResult[] {
  if (budgetTokens <= 0) return [];
  // Estimate overhead from MD formatting: ~20 tokens for heading + ~10 per entry for tags
  const overheadTokens = 20;
  let tokenEstimate = overheadTokens;
  const kept: RerankResult[] = [];

  for (const r of results) {
    const entryTokens = Math.ceil(r.content.length / charsPerToken) + 10; // 10 for tag+scores
    if (tokenEstimate + entryTokens > budgetTokens) break;
    tokenEstimate += entryTokens;
    kept.push(r);
  }
  return kept;
}

// ── Main Retrieval Function ───────────────────

export type RetrievalOptions = {
  store: MemoryStore;
  embedding: number[];
  memoryTopK: number;
  skillTopK: number;
  minSimilarity?: number;
  memoryTokenBudget?: number;
  skillTokenBudget?: number;
  rerankOptions?: RerankOptions;
};

export type RetrievalResult = {
  memoryMD: string;
  skillMD: string;
  matchedMemories: MemorySearchResult[];
  matchedSkills: Profile[];
};

export async function retrieveMemoriesAndSkills(opts: RetrievalOptions): Promise<RetrievalResult> {
  const { store, embedding, memoryTopK, skillTopK, minSimilarity = 0, memoryTokenBudget, skillTokenBudget, rerankOptions } = opts;

  const vecResults = await store.searchMemories({
    embedding,
    topK: memoryTopK,
    minSimilarity,
  });

  const neighborIds = new Set(vecResults.map((r) => r.id));
  const graphResults = await store.getGraphNeighbors([...neighborIds]);
  const newNeighbors = graphResults.filter((r) => !neighborIds.has(r.id));

  const combined = [...vecResults, ...newNeighbors];
  let reranked = rerank(combined, rerankOptions);

  if (memoryTokenBudget !== undefined && memoryTokenBudget > 0) {
    reranked = trimToTokenBudget(reranked, memoryTokenBudget);
  }

  const skills = await store.searchSkills({
    embedding,
    topK: skillTopK,
    minSimilarity,
  });

  // Trim skills to token budget (each skill is a standalone MD fragment)
  let trimmedSkills = skills;
  if (skillTokenBudget !== undefined && skillTokenBudget > 0 && skills.length > 0) {
    const overheadTokensPerSkill = 5; // spacing between skill blocks
    let tokenEstimate = 0;
    const kept: Profile[] = [];
    for (const skill of skills) {
      const skillTokens = Math.ceil(skill.content.length / 4) + overheadTokensPerSkill;
      if (tokenEstimate + skillTokens > skillTokenBudget) break;
      tokenEstimate += skillTokens;
      kept.push(skill);
    }
    trimmedSkills = kept;
  }

  return {
    memoryMD: formatMemoriesAsMD(reranked),
    skillMD: formatSkillsAsMD(trimmedSkills),
    matchedMemories: vecResults,
    matchedSkills: trimmedSkills,
  };
}
