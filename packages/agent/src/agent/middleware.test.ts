import { describe, expect, it } from "vitest";
import { compose, type AgentMiddleware, type AgentMiddlewareContext } from "./middleware";

describe("compose", () => {
  it("runs middleware onion-style", async () => {
    const order: number[] = [];
    const a: AgentMiddleware = async (_ctx, next) => {
      order.push(1);
      await next();
      order.push(4);
    };
    const b: AgentMiddleware = async (_ctx, next) => {
      order.push(2);
      await next();
      order.push(3);
    };
    const ctx = { event: "beforeRun" } as AgentMiddlewareContext;
    await compose([a, b])(ctx);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("rejects double next()", async () => {
    const bad: AgentMiddleware = async (_ctx, next) => {
      await next();
      await next();
    };
    await expect(compose([bad])({ event: "beforeRun" } as AgentMiddlewareContext)).rejects.toThrow(
      "next() called multiple times",
    );
  });
});
