import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Agent, createPermissionHook } from "@renx/agent";
import type { CanonicalStreamChunk } from "@renx/provider";
import { isRetryableLlmError, LLMError, minimax, openai } from "@renx/provider";
import { z } from "zod";

export const DEMO_MINIMAX_MODEL_ID = "MiniMax-M2.7";
export const OPENROUTER_ELEPHANT_ALPHA = "openrouter/elephant-alpha";

const weatherSchema = z.object({
  city: z.string().describe("城市名，如 Beijing"),
});

const timeSchema = z.object({
  timezone: z.string().describe("IANA 时区，如 Asia/Shanghai"),
});

export type ConfirmationMode = "terminal" | "always-allow" | "always-deny";

async function confirmInTerminal(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(`${prompt} (y/N) `);
  rl.close();
  const a = answer.trim().toLowerCase();
  return a === "y" || a === "yes";
}

function minimaxModelIdFromQuery(model: unknown): string {
  if (typeof model === "string") {
    return model.startsWith("minimax/") ? model.slice("minimax/".length) : model;
  }
  if (model && typeof model === "object" && "modelId" in model) {
    const id = (model as { modelId: unknown }).modelId;
    return typeof id === "string" ? id : "";
  }
  return "";
}

export function requireRealAgentEnv(): { useOpenRouter: boolean } {
  const hasMiniMax = Boolean(process.env.MINIMAX_API_KEY);
  const hasOpenRouter = Boolean(process.env.OPENROUTER_API_KEY);
  const useOpenRouter = !hasMiniMax && hasOpenRouter;
  if (!hasMiniMax && !hasOpenRouter) {
    throw new Error(
      "请设置 OPENROUTER_API_KEY（OpenRouter + elephant-alpha）或 MINIMAX_API_KEY 后重试。",
    );
  }
  return { useOpenRouter };
}

export function createRealDemoAgent(options: {
  useOpenRouter: boolean;
  confirmationMode?: ConfirmationMode;
}) {
  const { useOpenRouter, confirmationMode = "always-allow" } = options;
  const agent = new Agent({
    maxSteps: 8,
    llmClientOptions: useOpenRouter
      ? {
          vendors: ["openai"],
          apiKeys: { openai: process.env.OPENROUTER_API_KEY! },
          baseUrlByVendor: { openai: "https://openrouter.ai/api" },
        }
      : undefined,
    llmRetry: {
      maxRetries: 10,
      retryDelayMs: 1000,
      retryBackoffMultiplier: 2,
      isRetryable: ({ error, model }) => {
        if (!LLMError.isInstance(error)) return false;
        const modelStr = String(model);
        if (useOpenRouter && modelStr.includes(OPENROUTER_ELEPHANT_ALPHA)) {
          return (
            isRetryableLlmError(error) ||
            error.httpStatus === 529 ||
            (error.httpStatus != null && error.httpStatus >= 500)
          );
        }
        if (minimaxModelIdFromQuery(model) === DEMO_MINIMAX_MODEL_ID) {
          return isRetryableLlmError(error) || error.httpStatus === 529;
        }
        return false;
      },
    },
  });

  agent.use(
    createPermissionHook({
      toolsRequiringConfirmation: ["get_weather", "get_time"],
      onReject: confirmationMode === "always-deny" ? "pause" : "abort",
      rejectReason: "用户未确认工具调用（demo）",
      confirm: async ({ invocations }) => {
        console.log("\n--- 权限确认（permission hook）---");
        for (const inv of invocations) {
          console.log(`  工具: ${inv.name}  参数: ${JSON.stringify(inv.args)}`);
        }

        if (confirmationMode === "always-allow") return true;
        if (confirmationMode === "always-deny") return false;
        return confirmInTerminal("是否允许执行以上工具？");
      },
    }),
  );

  const reg = agent.getToolRegistry();
  reg.register({
    id: "get_weather",
    name: "get_weather",
    description: "查询给定城市当前天气（示例为模拟数据）",
    type: "read_only",
    schema: weatherSchema,
    execute: async (args) => {
      const { city } = weatherSchema.parse(args);
      return {
        success: true,
        content: `${city}：25°C，晴（demo 模拟）`,
        metadata: { city },
      };
    },
  });

  reg.register({
    id: "get_time",
    name: "get_time",
    description: "查询指定 IANA 时区的当前本地时间",
    type: "read_only",
    schema: timeSchema,
    execute: async (args) => {
      const { timezone } = timeSchema.parse(args);
      const local = new Date().toLocaleString("zh-CN", { timeZone: timezone });
      return {
        success: true,
        content: `${timezone} 当前时间：${local}`,
        metadata: { timezone },
      };
    },
  });

  return agent;
}

export function buildRealDemoRequest(useOpenRouter: boolean): Parameters<Agent["run"]>[0] {
  return {
    model: useOpenRouter ? openai(OPENROUTER_ELEPHANT_ALPHA) : minimax(DEMO_MINIMAX_MODEL_ID),
    systemPrompt: "你是简洁的中文助手，需要数据时调用工具，最后用一两句话总结。",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "北京现在天气怎样？那里现在几点？请用工具查。" }],
      },
    ],
    toolChoice: "auto",
    temperature: 0.2,
    ...(useOpenRouter
      ? {}
      : {
          providerOptions:
            process.env.AGENT_DEMO_SHOW_REASONING === "1"
              ? {
                  minimax: { reasoning_split: true },
                }
              : undefined,
        }),
  };
}

export function printStreamChunk(chunk: CanonicalStreamChunk) {
  switch (chunk.type) {
    case "text-delta":
      process.stdout.write(chunk.textDelta);
      break;
    case "reasoning-delta":
      if (process.env.AGENT_DEMO_SHOW_REASONING === "1") {
        process.stderr.write(chunk.reasoningDelta);
      }
      break;
    case "tool-call-delta":
      break;
    case "finish":
      process.stdout.write("\n");
      break;
  }
}
