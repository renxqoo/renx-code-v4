import { describe, expect, it, vi } from "vitest";
import zod from "zod";
import { createMcpTool } from "./mcp";

describe("createMcpTool", () => {
  it("adapts an MCP client into an agent tool", async () => {
    const client = {
      callTool: vi.fn().mockResolvedValue({
        content: "CRM hit",
        metadata: { customerId: "cust_123" },
      }),
    };
    const tool = createMcpTool({
      id: "crm_lookup",
      name: "lookup_customer",
      description: "Look up a customer in the CRM.",
      type: "read_only",
      schema: zod.object({ email: zod.string().email() }),
      client,
      server: "crm-mcp",
      toolName: "lookup_customer_by_email",
    });

    const result = await tool.execute({ email: "alice@example.com" });

    expect(client.callTool).toHaveBeenCalledWith({
      server: "crm-mcp",
      toolName: "lookup_customer_by_email",
      arguments: { email: "alice@example.com" },
    });
    expect(result).toEqual({
      success: true,
      content: "CRM hit",
      metadata: { customerId: "cust_123" },
    });
  });

  it("supports custom MCP result mapping", async () => {
    const client = {
      callTool: vi.fn().mockResolvedValue({
        content: '{"ok":true}',
        metadata: { raw: true },
        success: true,
      }),
    };
    const tool = createMcpTool({
      id: "deploy",
      name: "trigger_deploy",
      type: "write_only",
      schema: zod.object({ environment: zod.string() }),
      client,
      server: "ops-mcp",
      mapResult(result, args) {
        return {
          success: result.success ?? true,
          content: `Triggered deploy for ${args.environment}`,
          metadata: result.metadata ?? {},
        };
      },
    });

    expect(await tool.execute({ environment: "prod" })).toEqual({
      success: true,
      content: "Triggered deploy for prod",
      metadata: { raw: true },
    });
  });
});
