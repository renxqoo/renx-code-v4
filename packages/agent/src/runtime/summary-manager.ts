import { randomUUID } from "node:crypto";
import type { Message } from "../domain/message";
import type { AgentRunRecord, AgentRunSummary } from "./session-store";

export type SummaryManagerInput = {
  run: AgentRunRecord;
  messages: Message[];
};

export interface SummaryManager {
  maybeUpdate(input: SummaryManagerInput): Promise<AgentRunSummary | undefined>;
}

export type DefaultSummaryManagerOptions = {
  summarizeAfterMessageCount?: number;
  keepRecentMessages?: number;
  maxItemsPerSection?: number;
};

function textFromMessage(message: Message): string {
  return message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join(" ");
}

function collectFacts(messages: Message[], maxItems: number): string[] {
  const facts: string[] = [];
  for (const message of messages) {
    const text = textFromMessage(message);
    if (!text) continue;
    facts.push(`${message.role}: ${text}`);
    if (facts.length >= maxItems) break;
  }
  return facts;
}

export class DefaultSummaryManager implements SummaryManager {
  private readonly summarizeAfterMessageCount: number;
  private readonly keepRecentMessages: number;
  private readonly maxItemsPerSection: number;

  constructor(options: DefaultSummaryManagerOptions = {}) {
    this.summarizeAfterMessageCount = Math.max(6, options.summarizeAfterMessageCount ?? 14);
    this.keepRecentMessages = Math.max(4, options.keepRecentMessages ?? 8);
    this.maxItemsPerSection = Math.max(3, options.maxItemsPerSection ?? 6);
  }

  async maybeUpdate(input: SummaryManagerInput): Promise<AgentRunSummary | undefined> {
    if (input.messages.length < this.summarizeAfterMessageCount) {
      return input.run.summary;
    }

    const olderMessages = input.messages.slice(0, -this.keepRecentMessages);
    if (olderMessages.length === 0) {
      return input.run.summary;
    }

    const completedSteps = collectFacts(
      olderMessages.filter((message) => message.role === "assistant" || message.role === "tool"),
      this.maxItemsPerSection,
    );
    const knownFacts = collectFacts(olderMessages, this.maxItemsPerSection);
    const blockers = collectFacts(
      input.messages
        .slice(-this.keepRecentMessages)
        .filter((message) => textFromMessage(message).toLowerCase().includes("error")),
      this.maxItemsPerSection,
    );

    return {
      summaryId: randomUUID(),
      goal: textFromMessage(input.run.initial.messages[0] ?? { role: "user", content: [] }) || "Task in progress",
      completedSteps,
      knownFacts,
      blockers,
      constraints: [
        `Max steps: ${input.run.maxSteps}`,
        `Completed rounds: ${input.run.llmRounds}`,
      ],
      updatedAt: new Date().toISOString(),
    };
  }
}
