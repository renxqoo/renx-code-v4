export * from "../memory/context-builder";
export * from "../model/decision-parser";
export * from "../runtime/agent-runtime";
export * from "../runtime/harness";
export * from "../runtime/react-loop-engine";
export * from "../runtime/run-state-machine";
export * from "../termination/termination-policy";
export * from "../tools/tool-registry";
export * from "../tools/tool-runtime";
export * from "../types/index";

import type { AgentDefinition } from "../types/agent";
import type { ToolDescriptor } from "../types/tool";

export function createAgent<TAgent extends AgentDefinition>(agent: TAgent): TAgent {
  return agent;
}

export function createTool<TArgs = unknown, TResult = unknown>(
  tool: ToolDescriptor<TArgs, TResult>,
): ToolDescriptor<TArgs, TResult> {
  return tool;
}
