/**
 * 01-agent-query.ts — @renx/agent 多轮工具循环 + 流式输出 + 权限确认中间件
 *
 * 通过 `queryModel` 第二参数 `onStreamChunk` 在每一轮 LLM 请求时实时输出 token。
 * `get_weather` / `get_time` 调用前会在终端询问是否允许；选 N 将**立即终止**本次 `queryModel`（`onReject: "abort"`）。
 *
 * Run:  pnpm demo:agent
 * Env（二选一）:
 *   - OpenRouter + `openrouter/elephant-alpha`：`OPENROUTER_API_KEY=sk-or-v1-...`
 *   - MiniMax：`MINIMAX_API_KEY=...`
 *
 * LLM 重试：Provider 默认不重试；`Agent` 可配置 `llmRetry`（`isRetryable`、`retryDelayMs` 等）在 Agent 层按需重试。
 * 本 demo：`isRetryable` 对 MiniMax 仍以 529 为主；OpenRouter 同时信任 Provider 的 `retryable`（如 `RetryableError`），
 * 避免只认 529 导致其它可恢复错误不重试。调试：`DEBUG_LLM_RETRY=1` 打印 `code` / `httpStatus`。
 */
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Agent, createPermissionConfirmMiddleware } from "@renx/agent";
import type { CanonicalStreamChunk } from "@renx/provider";
import {
  getDefaultClient,
  isRetryableLlmError,
  LLMError,
  minimax,
  openai,
  resetDefaultClient,
} from "@renx/provider";
import { z } from "zod";

async function confirmInTerminal(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(`${prompt} (y/N) `);
  rl.close();
  const a = answer.trim().toLowerCase();
  return a === "y" || a === "yes";
}

const weatherSchema = z.object({
  city: z.string().describe("城市名，如 Beijing"),
});

const timeSchema = z.object({
  timezone: z.string().describe("IANA 时区，如 Asia/Shanghai"),
});

const DEMO_MINIMAX_MODEL_ID = "MiniMax-M2.7";

/** OpenRouter 上的模型 slug（经 `openai(...)` 后为 `openai/openrouter/elephant-alpha`）。 */
const OPENROUTER_ELEPHANT_ALPHA = "openrouter/elephant-alpha";

/** 与 `minimax(id)` / `QueryModelType.model` 对齐，取出裸 modelId。 */
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

function createDemoAgent(options: { useOpenRouter: boolean }) {
  const { useOpenRouter } = options;
  const agent = new Agent({
    maxSteps: 8,
    llmRetry: {
      maxRetries: 10,
      retryDelayMs: 1000,
      retryBackoffMultiplier: 2,
      isRetryable: ({ error, model }) => {
        if (!LLMError.isInstance(error)) return false;
        const modelStr = String(model);
        let allow: boolean;
        if (useOpenRouter && modelStr.includes(OPENROUTER_ELEPHANT_ALPHA)) {
          // RetryableError / RATE_LIMIT / 5xx 等：Provider 已标 retryable，勿只认 529
          allow =
            isRetryableLlmError(error) ||
            error.httpStatus === 529 ||
            (error.httpStatus != null && error.httpStatus >= 500);
        } else if (minimaxModelIdFromQuery(model) === DEMO_MINIMAX_MODEL_ID) {
          allow = isRetryableLlmError(error) || error.httpStatus === 529;
        } else {
          allow = false;
        }
        if (process.env.DEBUG_LLM_RETRY) {
          console.error("[llmRetry]", {
            allow,
            code: error.code,
            httpStatus: error.httpStatus,
            retryable: error.retryable,
            message: error.message,
          });
        }
        return allow;
      },
    },
  });
  agent.use(
    createPermissionConfirmMiddleware({
      toolsRequiringConfirm: ["get_weather", "get_time"],
      onReject: "abort",
      denyReason: "用户未在终端确认工具调用（示例）",
      confirm: async ({ invocations }) => {
        console.log("\n--- 权限确认（permission-confirm 中间件）---");
        for (const inv of invocations) {
          console.log(`  工具: ${inv.name}  参数: ${JSON.stringify(inv.args)}`);
        }
        return confirmInTerminal("是否允许执行以上工具？");
      },
    }),
  )
  // .use(async (ctx, next) => {
  //   console.log("before", ctx.event);
  //   await next();
  //   console.log("after", ctx.event);
  // });
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

function printStreamChunk(chunk: CanonicalStreamChunk) {
  switch (chunk.type) {
    case "text-delta":
      process.stdout.write(chunk.textDelta);
      break;
    case "reasoning-delta":
      process.stderr.write(chunk.reasoningDelta);
      break;
    case "tool-call-delta":
      break;
    case "finish":
      process.stdout.write("\n");
      break;
  }
}

async function run() {
  const useOpenRouter = Boolean(process.env.OPENROUTER_API_KEY);
  if (!useOpenRouter && !process.env.MINIMAX_API_KEY) {
    console.error(
      "请设置 OPENROUTER_API_KEY（OpenRouter + elephant-alpha）或 MINIMAX_API_KEY 后重试。",
    );
    process.exitCode = 1;
    return;
  }

  /** 必须在首次 `streamText` 前配置：Agent 的 `runtime` 使用模块级默认 Client。 */
  resetDefaultClient();
  if (useOpenRouter) {
    getDefaultClient({
      vendors: ["openai"],
      apiKeys: { openai: process.env.OPENROUTER_API_KEY! },
      /** 与内置路径 `v1/chat/completions` 拼接为 `https://openrouter.ai/api/v1/chat/completions` */
      baseUrlByVendor: { openai: "https://openrouter.ai/api" },
    });
  } else {
    getDefaultClient();
  }

  const agent = createDemoAgent({ useOpenRouter });

  console.log("=== Agent.queryModel（流式 + 工具循环）===\n");
  if (useOpenRouter) {
    console.log(`模型: OpenRouter / ${OPENROUTER_ELEPHANT_ALPHA}\n`);
  }

  const out = await agent.queryModel(
    {
      model: useOpenRouter ? openai(OPENROUTER_ELEPHANT_ALPHA) : minimax(DEMO_MINIMAX_MODEL_ID),
      systemPrompt: "你是简洁的中文助手，需要数据时调用工具，最后用一两句话总结。",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "北京现在天气怎样？那里现在几点？请用工具查。",
            },
          ],
        },
      ],
      toolChoice: "auto",
      temperature: 0.2,
      ...(useOpenRouter
        ? {}
        : {
            providerOptions: {
              minimax: { reasoning_split: true },
            },
          }),
    },
    { onStreamChunk: printStreamChunk },
  );

  // if (out.error) {
  //   console.error("\nerror:", out.error);
  // }

  // console.log("\n--- 元信息 ---");
  // console.log("finishReason:", out.finishReason);
  // console.log("llmRounds:", out.llmRounds);

  // console.log("\n--- 最终对话 messages（JSON）---\n");
  // console.log(JSON.stringify(out.messages, null, 2));
}

run().catch(console.error);
