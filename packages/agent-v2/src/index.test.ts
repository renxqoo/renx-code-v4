import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index";

describe("agent-v2", () => {
  it("exports package name", () => {
    expect(PACKAGE_NAME).toBe("@renx/agent-v2");
  });
});
