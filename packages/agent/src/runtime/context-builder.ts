import type { CanonicalTool } from "@renx/provider";
import type { ResolvedRunProfile } from "../agent/hooks";
import type { QueryModelType } from "../domain/query-model";
import type { AgentRunRecord } from "./session-store";

export type ContextBuilderInput = {
  run: AgentRunRecord;
  profile: ResolvedRunProfile;
  tools: CanonicalTool[] | undefined;
};

export interface ContextBuilder {
  build(input: ContextBuilderInput): Promise<QueryModelType>;
}

export type DefaultContextBuilderOptions = {
  workingWindowSize?: number;
};

function mergeProviderOptions(
  current?: Record<string, unknown>,
  patch?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!current && !patch) return undefined;
  if (!current) return patch ? { ...patch } : undefined;
  if (!patch) return { ...current };
  return { ...current, ...patch };
}

export class DefaultContextBuilder implements ContextBuilder {
  private readonly workingWindowSize: number;

  constructor(options: DefaultContextBuilderOptions = {}) {
    this.workingWindowSize = Math.max(4, options.workingWindowSize ?? 12);
  }

  async build(input: ContextBuilderInput): Promise<QueryModelType> {
    const recentMessages = input.run.messages.slice(-this.workingWindowSize);
    const summaryBlock = input.run.summary
      ? [
          "Session summary:",
          `Goal: ${input.run.summary.goal}`,
          `Completed: ${input.run.summary.completedSteps.join("; ") || "None"}`,
          `Known facts: ${input.run.summary.knownFacts.join("; ") || "None"}`,
          `Blockers: ${input.run.summary.blockers.join("; ") || "None"}`,
          `Constraints: ${input.run.summary.constraints.join("; ") || "None"}`,
        ].join("\n")
      : undefined;

    const systemPrompt = summaryBlock
      ? `${input.run.initial.systemPrompt}\n\n${summaryBlock}`
      : input.run.initial.systemPrompt;

    return {
      ...input.run.initial,
      ...input.profile.overrides,
      model: input.profile.overrides.model ?? input.run.initial.model,
      providerOptions: mergeProviderOptions(
        input.run.initial.providerOptions,
        input.profile.overrides.providerOptions,
      ),
      systemPrompt,
      messages: recentMessages,
      ...(input.tools ? { tools: input.tools } : {}),
      toolChoice: input.profile.overrides.toolChoice ?? input.run.initial.toolChoice,
    };
  }
}
