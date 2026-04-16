import { describe, expect, it } from "vitest";
import { cloneContextValue } from "./clone";

describe("cloneContextValue", () => {
  it("clones plain objects", () => {
    const original = { a: 1, b: { c: 2 } };
    const cloned = cloneContextValue(original);
    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
    expect((cloned as typeof original).b).not.toBe(original.b);
  });

  it("clones arrays", () => {
    const original = [1, { a: 2 }, [3]];
    const cloned = cloneContextValue(original);
    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
  });

  it("clones Date", () => {
    const original = new Date("2024-01-01T00:00:00Z");
    const cloned = cloneContextValue(original);
    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
    expect(cloned instanceof Date).toBe(true);
  });

  it("clones RegExp", () => {
    const original = /test/gi;
    const cloned = cloneContextValue(original);
    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
    expect((cloned as RegExp).source).toBe(original.source);
    expect((cloned as RegExp).flags).toBe(original.flags);
  });

  it("clones Map", () => {
    const original = new Map<string, unknown>([["key", { nested: true }]]);
    const cloned = cloneContextValue(original);
    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
    const clonedMap = cloned as Map<string, unknown>;
    expect(clonedMap.get("key")).not.toBe((original as Map<string, unknown>).get("key"));
  });

  it("clones Set", () => {
    const original = new Set([1, 2, 3]);
    const cloned = cloneContextValue(original);
    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
  });

  it("returns null as-is", () => {
    expect(cloneContextValue(null)).toBe(null);
  });

  it("returns undefined as-is", () => {
    expect(cloneContextValue(undefined)).toBe(undefined);
  });

  it("returns primitives as-is", () => {
    expect(cloneContextValue(42)).toBe(42);
    expect(cloneContextValue("hello")).toBe("hello");
    expect(cloneContextValue(true)).toBe(true);
  });

  it("returns functions as-is (non-cloneable)", () => {
    const fn = () => {};
    expect(cloneContextValue(fn)).toBe(fn);
  });

  it("clones nested structures", () => {
    const original = {
      date: new Date("2024-06-01"),
      arr: [new Map([["a", 1]]), /regex/],
      obj: { nested: { deep: true } },
    };
    const cloned = cloneContextValue(original);
    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
  });
});
