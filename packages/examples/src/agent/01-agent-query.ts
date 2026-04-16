/**
 * 01-agent-query.ts — @renx/agent 多轮工具循环 + 流式输出
 *
 * 通过 `queryModel` 第二参数 `onStreamChunk` 在每一轮 LLM 请求时实时输出 token。
 *
 * Run:  pnpm demo:agent
 * Env:  MINIMAX_API_KEY=...（或改用 openai(...) + OPENAI_API_KEY）
 */
import { Agent } from "@renx/agent";
import type { CanonicalStreamChunk } from "@renx/provider";
import { minimax } from "@renx/provider";
import { z } from "zod";

const weatherSchema = z.object({
  city: z.string().describe("城市名，如 Beijing"),
});

const timeSchema = z.object({
  timezone: z.string().describe("IANA 时区，如 Asia/Shanghai"),
});

function createDemoAgent() {
  const agent = new Agent({ maxSteps: 8 });
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
  if (!process.env.MINIMAX_API_KEY) {
    console.error("请设置 MINIMAX_API_KEY 后重试（或改代码使用 openai + OPENAI_API_KEY）。");
    process.exitCode = 1;
    return;
  }

  const agent = createDemoAgent();

  console.log("=== Agent.queryModel（流式 + 工具循环）===\n");

  const out = await agent.queryModel(
    {
      model: minimax("MiniMax-M2.7"),
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
      providerOptions: {
        minimax: { reasoning_split: true },
      },
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
