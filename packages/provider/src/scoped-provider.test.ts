import { describe, expect, it } from "vitest";
import { createScopedProvider } from "./scoped-provider.js";

describe("createScopedProvider", () => {
  it("returns undefined outside run", () => {
    const p = createScopedProvider<string>();
    expect(p.get()).toBeUndefined();
  });

  it("run exposes value inside callback", () => {
    const p = createScopedProvider<number>();
    const out = p.run(1, () => p.get());
    expect(out).toBe(1);
  });

  it("nests stacks correctly", () => {
    const p = createScopedProvider<string>();
    p.run("outer", () => {
      expect(p.get()).toBe("outer");
      p.run("inner", () => {
        expect(p.get()).toBe("inner");
      });
      expect(p.get()).toBe("outer");
    });
  });

  it("require throws when empty", () => {
    const p = createScopedProvider<number>();
    expect(() => p.require()).toThrow(/no value in scope/);
  });

  it("require returns innermost value", () => {
    const p = createScopedProvider<number>();
    p.run(1, () => {
      expect(p.require()).toBe(1);
    });
  });
});
