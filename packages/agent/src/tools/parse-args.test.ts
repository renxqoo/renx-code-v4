import { describe, expect, it } from "vitest";
import { parseToolCallArguments } from "./parse-args";

describe("parseToolCallArguments", () => {
  it("parses valid JSON object", () => {
    const result = parseToolCallArguments('{"path": "/tmp", "mode": "r"}');
    expect(result.ok).toBe(true);
    expect(result.args).toEqual({ path: "/tmp", mode: "r" });
    expect(result.parseError).toBeUndefined();
  });

  it("returns empty for empty string", () => {
    const result = parseToolCallArguments("");
    expect(result.ok).toBe(true);
    expect(result.args).toEqual({});
  });

  it("returns empty for whitespace-only string", () => {
    const result = parseToolCallArguments("   ");
    expect(result.ok).toBe(true);
    expect(result.args).toEqual({});
  });

  it("returns error for invalid JSON", () => {
    const result = parseToolCallArguments("{not json}");
    expect(result.ok).toBe(false);
    expect(result.args).toEqual({});
    expect(result.parseError).toBeDefined();
  });

  it("returns error for JSON array", () => {
    const result = parseToolCallArguments("[1,2,3]");
    expect(result.ok).toBe(false);
    expect(result.parseError).toMatch(/not a JSON object/);
  });

  it("returns error for JSON primitive", () => {
    const result = parseToolCallArguments('"hello"');
    expect(result.ok).toBe(false);
    expect(result.parseError).toMatch(/not a JSON object/);
  });

  it("returns error for null", () => {
    const result = parseToolCallArguments("null");
    expect(result.ok).toBe(false);
  });

  it("parses empty JSON object", () => {
    const result = parseToolCallArguments("{}");
    expect(result.ok).toBe(true);
    expect(result.args).toEqual({});
  });

  it("trims whitespace before parsing", () => {
    const result = parseToolCallArguments('  {"key": "value"}  ');
    expect(result.ok).toBe(true);
    expect(result.args).toEqual({ key: "value" });
  });
});
