import { describe, it, expect } from "vitest";
import { pipe } from "../../src/plugin.js";
import { withPromptGuard } from "../../src/plugins/prompt-guard.js";
import { agent } from "../../src/agent.js";
import { userMessage } from "../../src/message.js";
import {
  createSingleResponseClient,
  createTextDeltaChunk,
  createFinishChunk,
} from "../fixtures/mock-llm-client.js";
import type { AgentInput } from "../../src/index.js";
import type { AgentEvent } from "../../src/events.js";

describe("withPromptGuard", () => {
  it("runs agent when detect() returns true (safe input)", async () => {
    let detectCalled = false;

    const fn = pipe(
      withPromptGuard({
        detect: async () => {
          detectCalled = true;
          return true;
        },
        onBlock: async () => {},
      }),
      agent,
    );

    const events: AgentEvent[] = [];
    for await (const event of fn({
      model: "test",
      systemPrompt: "Be helpful",
      messages: [userMessage("Hi")],
      llmClient: createSingleResponseClient([
        createTextDeltaChunk("Hello"),
        createFinishChunk("stop"),
      ]),
    })) {
      events.push(event);
    }

    expect(detectCalled).toBe(true);
    expect(events.some(e => e.type === "run:started")).toBe(true);
    expect(events.some(e => e.type === "run:finished")).toBe(true);
  });

  it("blocks agent when detect() returns false (unsafe input)", async () => {
    let onBlockCalled = false;

    const fn = pipe(
      withPromptGuard({
        detect: async () => false,
        onBlock: async () => { onBlockCalled = true; },
      }),
      agent,
    );

    const events: AgentEvent[] = [];
    for await (const event of fn({
      model: "test",
      systemPrompt: "Be helpful",
      messages: [userMessage("evil prompt")],
      llmClient: createSingleResponseClient([
        createTextDeltaChunk("Hello"),
        createFinishChunk("stop"),
      ]),
    })) {
      events.push(event);
    }

    expect(onBlockCalled).toBe(true);
    expect(events.length).toBe(0);
  });

  it("passes correct AgentInput to detect()", async () => {
    let detectedInput: AgentInput | undefined;

    const fn = pipe(
      withPromptGuard({
        detect: async (input) => {
          detectedInput = input;
          return true;
        },
        onBlock: async () => {},
      }),
      agent,
    );

    for await (const _ of fn({
      model: "gpt-4",
      systemPrompt: "Test system",
      messages: [userMessage("Hello")],
      llmClient: createSingleResponseClient([
        createTextDeltaChunk("Reply"),
        createFinishChunk("stop"),
      ]),
    })) { /* consume */ }

    expect(detectedInput).toBeDefined();
    expect(detectedInput!.model).toBe("gpt-4");
    expect(detectedInput!.systemPrompt).toBe("Test system");
    expect(detectedInput!.messages.length).toBeGreaterThan(0);
  });
});
