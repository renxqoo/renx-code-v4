import type { LLMClient } from "@renx/provider";
import type { AgentLogger } from "./logger";
import type { AgentHook } from "./hooks";
import type { LlmRetryConfig, QueryModelHooks, QueryModelOutcome } from "./types";
import type { QueryModelType } from "../domain/query-model";
import type { SandboxRegistry } from "../sandbox/sandbox-registry";
import type { ToolRegistry } from "../tools/registry";
import { AgentRuntime } from "../runtime/agent-runtime";
import type { ContextBuilder } from "../runtime/context-builder";
import type { AgentSessionStore } from "../runtime/session-store";
import type { SummaryManager } from "../runtime/summary-manager";
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
  sessionStore?: AgentSessionStore;
  terminationPolicy?: TerminationPolicy;
  contextBuilder?: ContextBuilder;
  summaryManager?: SummaryManager;
};

export async function runQueryModelLoop(params: RunQueryModelLoopParams): Promise<QueryModelOutcome> {
  const runtime = new AgentRuntime({
    maxSteps: params.maxSteps,
    registry: params.registry,
    sandboxRegistry: params.sandboxRegistry,
    hooks: params.enterpriseHooks,
    llmRetry: params.llmRetry,
    llmClient: params.llmClient,
    logger: params.logger,
    sessionStore: params.sessionStore,
    terminationPolicy: params.terminationPolicy,
    contextBuilder: params.contextBuilder,
    summaryManager: params.summaryManager,
  });

  return runtime.run(params.initial, params.hooks);
}
