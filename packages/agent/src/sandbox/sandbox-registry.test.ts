import { describe, expect, it } from "vitest";
import { InProcessSandboxBackend } from "./backends/in-process";
import { SandboxRegistry } from "./sandbox-registry";

describe("SandboxRegistry", () => {
  it("resolves registered profile", () => {
    const a = new InProcessSandboxBackend();
    const b = { id: "mock", execute: async () => ({ success: true, content: "", metadata: {} }) };
    const reg = new SandboxRegistry(a).register("custom", b);
    expect(reg.resolve("custom").id).toBe("mock");
  });

  it("falls back when profile unknown", () => {
    const fallback = new InProcessSandboxBackend();
    const reg = new SandboxRegistry(fallback);
    expect(reg.resolve("unknown").id).toBe("in_process");
  });
});
