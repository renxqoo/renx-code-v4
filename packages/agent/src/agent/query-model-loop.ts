import type { LLMClient } from "@renx/provider";
import type { AgentLogger } from "./logger";
import type { AgentHook } from "./hooks";
import type { LlmRetryConfig, QueryModelHooks, QueryModelOutcome } from "./types";
import type { QueryModelType } from "../domain/query-model";
import type { SandboxRegistry } from "../sandbox/sandbox-registry";
import type { ToolRegistry } from "../tools/registry";
import { AgentRuntime } from "../runtime/agent-runtime";
import type { AgentCheckpointStore } from "../runtime/checkpoint-store";
import type { TerminationPolicy } from "../runtime/termination-policy";

export type RunQueryModelLoopParams = {
  initial: QueryModelType;
  maxSteps: number;
  registry: ToolRegistry;
  hooks?: QueryModelHooks;
  enterpriseHooks?: AgentHook[];
  sandboxRegistry: SandboxRegistry;
  llmRetry?: LlmRetryConfig;
  llmClient?: LLMClient;
  logger?: AgentLogger;
  checkpointStore?: AgentCheckpointStore;
  terminationPolicy?: TerminationPolicy;
};

/**
 * Compatibility wrapper around the enterprise runtime entrypoint.
 * The legacy name is kept so tests and local scripts can call a stable helper,
 * while the orchestration now lives in `runtime/`.
 */
export async function runQueryModelLoop(params: RunQueryModelLoopParams): Promise<QueryModelOutcome> {
  const runtime = new AgentRuntime({
    maxSteps: params.maxSteps,
    registry: params.registry,
    sandboxRegistry: params.sandboxRegistry,
    hooks: params.enterpriseHooks,
    llmRetry: params.llmRetry,
    llmClient: params.llmClient,
    logger: params.logger,
    checkpointStore: params.checkpointStore,
    terminationPolicy: params.terminationPolicy,
  });

  return runtime.run(params.initial, params.hooks);
}
