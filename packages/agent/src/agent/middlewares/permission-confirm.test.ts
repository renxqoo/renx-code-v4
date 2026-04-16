import { describe, expect, it } from "vitest";
import { compose } from "../middleware";
import type { AgentMiddlewareContext } from "../middleware";
import { createPermissionConfirmMiddleware } from "./permission-confirm";

describe("createPermissionConfirmMiddleware", () => {
  it("sets deny when confirm returns false for a flagged tool", async () => {
    const mw = createPermissionConfirmMiddleware({
      toolsRequiringConfirm: ["delete_file"],
      confirm: async () => false,
    });
    const ctx: AgentMiddlewareContext = {
      event: "beforeToolExecution",
      toolInvocation: {
        invocations: [{ callId: "c1", name: "delete_file", args: { path: "/tmp" } }],
      },
    };
    await compose([mw])(ctx, async () => {});
    expect(ctx.control?.decision).toBe("deny");
    expect(ctx.control?.stopReason).toMatch(/confirm/i);
  });

  it("does not set deny when no invocation matches toolsRequiringConfirm", async () => {
    const mw = createPermissionConfirmMiddleware({
      toolsRequiringConfirm: ["delete_file"],
      confirm: async () => false,
    });
    const ctx: AgentMiddlewareContext = {
      event: "beforeToolExecution",
      toolInvocation: {
        invocations: [{ callId: "c1", name: "read_file", args: {} }],
      },
    };
    await compose([mw])(ctx, async () => {});
    expect(ctx.control?.decision).toBeUndefined();
  });

  it("uses requiresConfirm when provided", async () => {
    const mw = createPermissionConfirmMiddleware({
      requiresConfirm: (name) => name.startsWith("admin_"),
      confirm: async () => false,
      denyReason: "custom",
    });
    const ctx: AgentMiddlewareContext = {
      event: "beforeToolExecution",
      toolInvocation: {
        invocations: [{ callId: "c1", name: "admin_reset", args: {} }],
      },
    };
    await compose([mw])(ctx, async () => {});
    expect(ctx.control?.decision).toBe("deny");
    expect(ctx.control?.stopReason).toBe("custom");
  });

  it("sets continue false when onReject is abort", async () => {
    const mw = createPermissionConfirmMiddleware({
      toolsRequiringConfirm: ["delete_file"],
      confirm: async () => false,
      onReject: "abort",
      denyReason: "aborted",
    });
    const ctx: AgentMiddlewareContext = {
      event: "beforeToolExecution",
      toolInvocation: {
        invocations: [{ callId: "c1", name: "delete_file", args: {} }],
      },
    };
    await compose([mw])(ctx, async () => {});
    expect(ctx.control?.continue).toBe(false);
    expect(ctx.control?.decision).toBeUndefined();
    expect(ctx.control?.stopReason).toBe("aborted");
  });

  it("passes through other events", async () => {
    const mw = createPermissionConfirmMiddleware({
      toolsRequiringConfirm: ["x"],
      confirm: async () => false,
    });
    const ctx: AgentMiddlewareContext = {
      event: "beforeModelCall",
    };
    await compose([mw])(ctx, async () => {});
    expect(ctx.control?.decision).toBeUndefined();
  });
});
