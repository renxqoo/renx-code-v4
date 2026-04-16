import { describe, expect, it, vi } from "vitest";
import { compose } from "../middleware";
import type { AgentMiddlewareContext } from "../middleware";
import { createStoreMessagesMiddleware } from "./store-messages";

describe("createStoreMessagesMiddleware", () => {
  it("calls save on beforeModelCall when mode is before_each_llm", async () => {
    const save = vi.fn();
    const mw = createStoreMessagesMiddleware({ save, mode: "before_each_llm" });
    const ctx: AgentMiddlewareContext = {
      event: "beforeModelCall",
      context: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], llmRounds: 1 },
    };
    await compose([mw])(ctx, async () => {});
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].meta.llmRound).toBe(1);
  });

  it("calls save on beforeFinish when mode is on_finish", async () => {
    const save = vi.fn();
    const mw = createStoreMessagesMiddleware({ save, mode: "on_finish" });
    const ctx: AgentMiddlewareContext = {
      event: "beforeFinish",
      context: { messages: [] },
      eventData: { reason: "success" },
    };
    await compose([mw])(ctx, async () => {});
    expect(save).toHaveBeenCalledWith({
      messages: [],
      meta: { event: "beforeFinish", finishReason: "success" },
    });
  });

  it("does not save beforeModelCall when mode is on_finish", async () => {
    const save = vi.fn();
    const mw = createStoreMessagesMiddleware({ save, mode: "on_finish" });
    await compose([mw])(
      {
        event: "beforeModelCall",
        context: { messages: [] },
      } as AgentMiddlewareContext,
      async () => {},
    );
    expect(save).not.toHaveBeenCalled();
  });
});
