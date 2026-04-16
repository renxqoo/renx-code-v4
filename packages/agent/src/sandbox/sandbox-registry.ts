import type { SandboxBackend } from "./types";

/**
 * 将逻辑上的 `profileId`（策略名/环境名）映射到具体 `SandboxBackend`。
 * 不同部署可注册不同组合，例如：
 * - `in_process` → InProcessSandboxBackend
 * - `docker_node` → DockerSandboxBackend（另包实现）
 * - `remote` → 调用公司沙箱服务的 HttpSandboxBackend
 */
export class SandboxRegistry {
  private readonly backends = new Map<string, SandboxBackend>();
  private readonly fallback: SandboxBackend;

  constructor(fallback: SandboxBackend) {
    this.fallback = fallback;
  }

  register(profileId: string, backend: SandboxBackend): this {
    this.backends.set(profileId, backend);
    return this;
  }

  resolve(profileId: string | undefined): SandboxBackend {
    if (!profileId) return this.fallback;
    return this.backends.get(profileId) ?? this.fallback;
  }

  has(profileId: string): boolean {
    return this.backends.has(profileId);
  }
}
