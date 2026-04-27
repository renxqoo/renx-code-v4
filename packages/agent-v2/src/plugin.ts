import type { AgentFn } from "./types.js";

export type { AgentFn } from "./types.js";

export type Plugin = (inner: AgentFn) => AgentFn;

export function pipe(
  ...fns: [...Plugin[], AgentFn]
): AgentFn {
  if (fns.length === 0) {
    throw new Error("pipe() requires at least one function (the innermost agent).");
  }
  const len = fns.length;
  let composed: AgentFn = fns[len - 1] as AgentFn;
  for (let i = len - 2; i >= 0; i--) {
    composed = (fns[i] as Plugin)(composed);
  }
  return composed;
}
