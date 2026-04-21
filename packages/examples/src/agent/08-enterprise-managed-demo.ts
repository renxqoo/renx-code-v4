/**
 * 08-enterprise-managed-demo.ts — 企业版 managed agent demo
 *
 * 展示能力：
 * - FileSessionStore 持久化 run / trace
 * - AgentWorker 扫描 + lease + 自动 start/resume
 * - HttpSandboxBackend 远程执行写工具
 * - MCP tool adapter（lookup_customer）
 * - telemetry 事件采集
 *
 * Run:
 *   pnpm --filter @renx/examples demo:agent-enterprise
 */
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { EnterpriseManagedDemoService } from "./server/enterprise-managed-service";

function extractFinalText(messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>): string {
  const assistant = [...messages].reverse().find((message) => message.role === "assistant");
  if (!assistant) return "";
  return assistant.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function printHelp(): void {
  console.log(`
Commands:
  help
  sample
  create <prompt>
  list
  get <runId>
  trace <runId> [limit]
  approve <runId>
  telemetry [limit]
  state
  exit
`.trim());
}

function printSamples(): void {
  console.log(`
Sample prompts:
  create lookup alice@example.com and notify the customer
  create open an incident ticket for alice@example.com
  create lookup bob@example.com, open an incident ticket, then email the customer
`.trim());
}

async function run() {
  const service = await EnterpriseManagedDemoService.create();
  const workerAbort = new AbortController();
  const workerTask = service.runWorkerLoop(workerAbort.signal);
  const rl = readline.createInterface({ input, output });

  console.log("=== Enterprise managed agent demo started ===");
  console.log("Type `help` to see available commands.\n");

  try {
    while (true) {
      const line = (await rl.question("> ")).trim();
      if (!line) continue;

      const [command, ...rest] = line.split(" ");
      const value = rest.join(" ").trim();

      switch (command) {
        case "help": {
          printHelp();
          break;
        }

        case "sample": {
          printSamples();
          break;
        }

        case "create": {
          if (!value) {
            console.log("Usage: create <prompt>");
            break;
          }
          const run = await service.createRun({ prompt: value });
          console.log({
            runId: run.runId,
            status: run.status,
          });
          break;
        }

        case "list": {
          const runs = await service.listRuns();
          console.table(
            runs.map((run) => ({
              runId: run.runId,
              status: run.status,
              llmRounds: run.llmRounds,
              stopReason: run.stopReason ?? "",
              pendingApproval: run.pendingApproval?.invocations.length ?? 0,
            })),
          );
          break;
        }

        case "get": {
          if (!value) {
            console.log("Usage: get <runId>");
            break;
          }
          const run = await service.getRun(value);
          if (!run) {
            console.log("Run not found.");
            break;
          }
          console.log({
            runId: run.runId,
            status: run.status,
            llmRounds: run.llmRounds,
            stopReason: run.stopReason,
            pendingApproval: run.pendingApproval?.invocations.map((invocation) => invocation.name),
            finalText: extractFinalText(run.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>),
          });
          break;
        }

        case "trace": {
          if (!value) {
            console.log("Usage: trace <runId> [limit]");
            break;
          }
          const [runId, limitRaw] = value.split(" ");
          const limit = limitRaw ? Number(limitRaw) : undefined;
          const trace = await service.getTrace(runId, Number.isFinite(limit) ? limit : undefined);
          console.log(trace.map((event) => event.type));
          break;
        }

        case "approve": {
          if (!value) {
            console.log("Usage: approve <runId>");
            break;
          }
          service.approve(value);
          console.log({ runId: value, action: "approved" });
          break;
        }

        case "telemetry": {
          const limit = value ? Number(value) : 10;
          console.table(
            service.getTelemetry(Number.isFinite(limit) ? limit : 10).map((event) => ({
              at: event.at,
              name: event.name,
              runId: event.runId ?? "",
              status: event.status ?? "",
              ownerId: event.ownerId ?? "",
            })),
          );
          break;
        }

        case "state": {
          console.log({
            stateDirectory: service.stateDirectory,
            sandboxEndpoint: service.sandbox.endpoint,
            telemetryEvents: service.getTelemetry(1000).length,
          });
          break;
        }

        case "exit": {
          return;
        }

        default: {
          console.log(`Unknown command: ${command}`);
          printHelp();
        }
      }
    }
  } finally {
    rl.close();
    workerAbort.abort();
    await workerTask.catch(() => {});
    await service.close();
  }
}

run().catch(console.error);
