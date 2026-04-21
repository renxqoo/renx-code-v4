import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { HttpSandboxExecutePayload } from "@renx/agent";

export type EnterpriseSandboxServer = {
  endpoint: string;
  close(): Promise<void>;
};

async function readRequestBody(req: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function responseForPayload(payload: HttpSandboxExecutePayload): { success: boolean; content: string; metadata: Record<string, unknown> } {
  const metadata = {
    backend: "enterprise-http-sandbox",
    tool: payload.tool.name,
    tenantId: payload.context.tenantId,
    traceId: payload.context.traceId,
  };

  if (payload.tool.name === "send_email") {
    const to = String(payload.args.to ?? "unknown@example.com");
    const subject = String(payload.args.subject ?? "Untitled");
    return {
      success: true,
      content: `Queued email "${subject}" to ${to}.`,
      metadata,
    };
  }

  if (payload.tool.name === "create_incident_ticket") {
    const title = String(payload.args.title ?? "Untitled incident");
    return {
      success: true,
      content: `Created incident ticket INC-2401 for "${title}".`,
      metadata: {
        ...metadata,
        ticketId: "INC-2401",
      },
    };
  }

  return {
    success: false,
    content: `Remote sandbox does not recognize tool ${payload.tool.name}.`,
    metadata,
  };
}

export async function startEnterpriseSandboxServer(): Promise<EnterpriseSandboxServer> {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/execute") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: false, content: "Not found", metadata: {} }));
      return;
    }

    try {
      const raw = await readRequestBody(req);
      const payload = JSON.parse(raw) as HttpSandboxExecutePayload;
      const response = responseForPayload(payload);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          success: false,
          content: error instanceof Error ? error.message : String(error),
          metadata: {},
        }),
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${address.port}/execute`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}
