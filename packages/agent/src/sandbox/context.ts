import type { ResolvedRunProfile } from "../agent/hooks";
import type { AgentTool } from "../tools/type";
import type { SandboxExecutionContext } from "./types";

/**
 * Build sandbox execution context from the resolved run profile plus per-tool overrides.
 * The runtime owns these values; hooks may influence them only through the restricted
 * run profile assignment API.
 */
export function buildSandboxExecutionContext(
  profile: ResolvedRunProfile,
  tool: AgentTool,
): SandboxExecutionContext {
  return {
    profileId: tool.sandboxProfileId ?? profile.sandboxProfileId ?? "in_process",
    traceId: profile.traceId,
    tenantId: profile.tenantId,
    policy: profile.sandboxPolicy,
  };
}
