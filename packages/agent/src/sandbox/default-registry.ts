import { InProcessSandboxBackend } from "./backends/in-process";
import { SandboxRegistry } from "./sandbox-registry";

/** 默认仅含 `in_process` profile，与历史进程内执行行为一致。 */
export function createDefaultSandboxRegistry(): SandboxRegistry {
  return new SandboxRegistry(new InProcessSandboxBackend());
}
