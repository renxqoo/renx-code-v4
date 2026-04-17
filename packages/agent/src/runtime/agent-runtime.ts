import type { LLMClient } from "@renx/provider";
import type { AgentHook } from "../agent/hooks";
import type { LlmRetryConfig, QueryModelHooks, QueryModelOutcome } from "../agent/types";
import type { AgentLogger } from "../agent/logger";
import type { QueryModelType } from "../domain/query-model";
import type { SandboxRegistry } from "../sandbox/sandbox-registry";
import type { ToolRegistry } from "../tools/registry";
import type { AgentCheckpointStore } from "./checkpoint-store";
import { noopCheckpointStore } from "./checkpoint-store";
import { Harness } from "./harness";
import { RunStateMachine } from "./run-state-machine";
import type { TerminationPolicy } from "./termination-policy";
import { DefaultTerminationPolicy } from "./termination-policy";

export type AgentRuntimeConfig = {
  maxSteps: number;
  registry: ToolRegistry;
  sandboxRegistry: SandboxRegistry;
  hooks?: AgentHook[];
  llmRetry?: LlmRetryConfig;
  llmClient?: LLMClient;
  logger?: AgentLogger;
  checkpointStore?: AgentCheckpointStore;
  terminationPolicy?: TerminationPolicy;
};

export class AgentRuntime {
  constructor(private readonly config: AgentRuntimeConfig) {}

  async run(initial: QueryModelType, hooks?: QueryModelHooks): Promise<QueryModelOutcome> {
    const checkpointStore = this.config.checkpointStore ?? noopCheckpointStore;
    const runStateMachine = new RunStateMachine(
      {
        initial,
        maxSteps: this.config.maxSteps,
      },
      checkpointStore,
    );

    await runStateMachine.persistRun();
    await runStateMachine.start();

    const harness = new Harness({
      maxSteps: this.config.maxSteps,
      registry: this.config.registry,
      sandboxRegistry: this.config.sandboxRegistry,
      hooks,
      enterpriseHooks: this.config.hooks,
      llmRetry: this.config.llmRetry,
      llmClient: this.config.llmClient,
      logger: this.config.logger,
      terminationPolicy: this.config.terminationPolicy ?? new DefaultTerminationPolicy(),
      runStateMachine,
    });

    try {
      const outcome = await harness.run(initial);
      const finalMessages = outcome.messages;
      if (outcome.error) {
        await runStateMachine.fail(finalMessages, outcome.error, outcome.stopReason ?? "error");
      } else {
        const stopReason =
          (this.config.terminationPolicy ?? new DefaultTerminationPolicy()).finalStopReason(outcome);
        await runStateMachine.complete(finalMessages, stopReason);
      }
      return outcome;
    } catch (error) {
      await runStateMachine.fail(initial.messages, error);
      return {
        runId: runStateMachine.runId,
        messages: [...initial.messages],
        finishReason: "error",
        llmRounds: 0,
        lastStream: {
          ok: false,
          error,
          textStream: (async function* () {})(),
          text: Promise.resolve(""),
          reasoning: Promise.resolve(""),
          toolCalls: Promise.resolve([]),
          usage: Promise.resolve(undefined),
          finishReason: Promise.resolve("error"),
        },
        error,
      };
    }
  }
}
