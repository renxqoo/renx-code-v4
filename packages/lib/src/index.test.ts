import { describe, expect, it } from "vitest";
import { add } from "./index.js";

describe("add", () => {
  it("returns sum of two numbers", () => {
    expect(add(1, 2)).toBe(3);
  });
});
