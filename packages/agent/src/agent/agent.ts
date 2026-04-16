import type { QueryModelType } from "../domain/query-model";
import { ToolRegistry } from "../tools/registry";
import { runQueryModelLoop } from "./query-model-loop";
import type { AgentConstructorConfig, QueryModelHooks, QueryModelOutcome } from "./types";

export type { AgentConstructorConfig, QueryModelHooks, QueryModelOutcome } from "./types";

export class Agent {
  protected readonly config: { maxSteps: number };
  private readonly registry: ToolRegistry;

  constructor(config: AgentConstructorConfig) {
    this.config = { maxSteps: config.maxSteps };
    this.registry = config.registry ?? new ToolRegistry();
  }

  getToolRegistry(): ToolRegistry {
    return this.registry;
  }

  async queryModel(initial: QueryModelType, hooks?: QueryModelHooks): Promise<QueryModelOutcome> {
    return runQueryModelLoop({
      initial,
      maxSteps: this.config.maxSteps,
      registry: this.registry,
      hooks,
    });
  }
}
