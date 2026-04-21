/**
 * 07-worker-daemon.ts — 常驻后台 worker demo
 *
 * 纯终端交互，不内置 HTTP。
 *
 * Run:
 *   pnpm --filter @renx/examples demo:agent-worker-daemon
 *
 * Commands:
 *   help
 *   create <prompt>
 *   list
 *   get <runId>
 *   trace <runId>
 *   approve <runId>
 *   cancel <runId>
 *   exit
 */
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { BackgroundAgentService } from "./server/background-service";

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
  create <prompt>
  list
  get <runId>
  trace <runId>
  approve <runId>
  cancel <runId>
  exit
`.trim());
}

async function run() {
  const service = new BackgroundAgentService();
  const workerAbort = new AbortController();
  const workerTask = service.runWorkerLoop(workerAbort.signal);
  const rl = readline.createInterface({ input, output });

  console.log("=== Background worker daemon started ===");
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

        case "create": {
          if (!value) {
            console.log("Usage: create <prompt>");
            break;
          }
          const run = await service.createRun({ prompt: value });
          console.log({
            runId: run.runId,
            status: run.status,
            queuedJobs: service.queue.size(),
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
            console.log("Usage: trace <runId>");
            break;
          }
          const trace = await service.getTrace(value);
          console.log(trace.map((event) => event.type));
          break;
        }

        case "approve": {
          if (!value) {
            console.log("Usage: approve <runId>");
            break;
          }
          await service.approveAndResume(value);
          console.log({ runId: value, action: "approved", queuedJobs: service.queue.size() });
          break;
        }

        case "cancel": {
          if (!value) {
            console.log("Usage: cancel <runId>");
            break;
          }
          const run = await service.cancel(value);
          console.log({ runId: run.runId, status: run.status });
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
    await workerTask;
  }
}

run().catch(console.error);
