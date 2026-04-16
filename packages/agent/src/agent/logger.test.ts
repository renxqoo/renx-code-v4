import { describe, expect, it, vi } from "vitest";
import { noopLogger, consoleLogger } from "./logger";

describe("noopLogger", () => {
  it("has all required methods that do nothing", () => {
    expect(() => noopLogger.debug("test")).not.toThrow();
    expect(() => noopLogger.info("test")).not.toThrow();
    expect(() => noopLogger.warn("test")).not.toThrow();
    expect(() => noopLogger.error("test")).not.toThrow();
  });

  it("accepts meta parameter without error", () => {
    expect(() => noopLogger.debug("test", { key: "value" })).not.toThrow();
  });
});

describe("consoleLogger", () => {
  it("calls console.debug for debug", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    consoleLogger.debug("msg", { k: 1 });
    expect(spy).toHaveBeenCalledWith("[agent] msg", { k: 1 });
    spy.mockRestore();
  });

  it("calls console.info for info", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    consoleLogger.info("msg");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("calls console.warn for warn", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleLogger.warn("msg");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("calls console.error for error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleLogger.error("msg");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
