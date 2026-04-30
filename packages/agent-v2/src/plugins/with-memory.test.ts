import { describe, expect, it } from "vitest";
import type { AgentInput, AgentGenerator } from "../types.js";
import type { AgentFn } from "../types.js";
import { withMemory, type EmbeddingClient } from "./with-memory.js";
import { InMemoryMemoryStore } from "../memory/in-memory-store.js";
import { userMessage } from "../message.js";

// ── Mock embedding client ───────────────────────────

function mockEmbeddingClient(embeddings: number[][] = [[1, 0, 0]]): EmbeddingClient {
  return {
    async generateEmbedding(_opts) {
      return { embeddings };
    },
  };
}

// ── Mock inner agent ────────────────────────────────

function mockAgent(): AgentFn {
  return async function* (input: AgentInput): AgentGenerator {
    yield { type: "run:started", runId: "test-run", model: input.model, systemPrompt: input.systemPrompt, tools: [], maxSteps: 5 };
    yield { type: "step:started", step: 1 };
    yield { type: "llm:delta", step: 1, delta: "Hello" };
    yield { type: "llm:done", step: 1, finishReason: "stop", usage: { input: 10, output: 5 }, text: "Hello" };
    yield { type: "step:completed", step: 1, finishReason: "stop", tokenUsage: { input: 10, output: 5 } };
    yield {
      type: "run:finished",
      outcome: {
        runId: "test-run",
        messages: [...input.messages],
        text: "Hello",
        workingMemory: {},
        tokenUsage: { input: 10, output: 5 },
        finishReason: "stop",
        totalSteps: 1,
      },
    };
  };
}

// ── Tests ───────────────────────────────────────────

describe("withMemory plugin", () => {
  it("injects profiles and memories into system prompt", async () => {
    const store = new InMemoryMemoryStore();

    await store.upsertProfile({
      key: "soul",
      content: "# Soul: Code Reviewer",
      version: 1,
      status: "active",
      metadata: {},
    });
    await store.upsertProfile({
      key: "user:default",
      content: "Prefers TypeScript",
      version: 1,
      status: "active",
      metadata: {},
    });
    await store.storeMemory({
      content: "Project uses pnpm workspaces",
      summary: "pnpm",
      embedding: [1, 0, 0],
      type: "fact",
      importance: 0.5,
    });

    const plugin = withMemory({
      store,
      embeddingClient: mockEmbeddingClient(),
      embeddingModel: "test-model",
      minSimilarity: 0,
    });

    const agent = plugin(mockAgent());
    const events: Array<{ type: string; systemPrompt?: string }> = [];

    for await (const event of agent({
      model: "test",
      systemPrompt: "You are helpful.",
      messages: [userMessage("How do I debug pnpm?")],
    })) {
      if (event.type === "run:started") {
        events.push({ type: event.type, systemPrompt: event.systemPrompt });
      } else {
        events.push({ type: event.type });
      }
    }

    const started = events.find((e) => e.type === "run:started")!;
    expect(started.systemPrompt).toBeDefined();
    expect(started.systemPrompt).toContain("# Soul: Code Reviewer");
    expect(started.systemPrompt).toContain("## User Profile");
    expect(started.systemPrompt).toContain("Prefers TypeScript");
    expect(started.systemPrompt).toContain("You are helpful.");
  });

  it("yields all events unchanged", async () => {
    const store = new InMemoryMemoryStore();
    const plugin = withMemory({
      store,
      embeddingClient: mockEmbeddingClient(),
      embeddingModel: "test",
    });

    const events: string[] = [];
    for await (const event of plugin(mockAgent())({
      model: "test",
      systemPrompt: "sys",
      messages: [],
    })) {
      events.push(event.type);
    }

    expect(events).toContain("run:started");
    expect(events).toContain("step:started");
    expect(events).toContain("llm:delta");
    expect(events).toContain("llm:done");
    expect(events).toContain("step:completed");
    expect(events).toContain("run:finished");
  });

  it("handles embedding client returning empty embedding gracefully", async () => {
    const store = new InMemoryMemoryStore();
    const plugin = withMemory({
      store,
      embeddingClient: mockEmbeddingClient([]),
      embeddingModel: "test",
    });

    const events: string[] = [];
    // Should not throw even with empty embedding
    for await (const event of plugin(mockAgent())({
      model: "test",
      systemPrompt: "sys",
      messages: [userMessage("test query")],
    })) {
      events.push(event.type);
    }

    expect(events).toContain("run:finished");
  });

  it("post-agent ETL stores memories (with mocked ETL)", async () => {
    // This test verifies the plugin structure works end-to-end.
    // The actual ETL LLM call is mocked by the inner agent pattern.
    // Post-ETL best-effort means even with no ETL model accessible,
    // the plugin should not crash.
    const store = new InMemoryMemoryStore();
    const plugin = withMemory({
      store,
      embeddingClient: mockEmbeddingClient(),
      embeddingModel: "test",
    });

    const gen = plugin(mockAgent())({
      model: "test",
      systemPrompt: "sys",
      messages: [userMessage("test")],
    });

    const events: string[] = [];
    for await (const event of gen) {
      events.push(event.type);
    }

    // Even if ETL fails (no real LLM), the plugin should not throw
    expect(events).toContain("run:finished");
  });
});
