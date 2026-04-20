/**
 * 01-agent-query.ts — 高层 `Agent.run()` demo
 *
 * Run: pnpm demo:agent
 * Env:
 *   - OPENROUTER_API_KEY=...
 *   - 或 MINIMAX_API_KEY=...
 */
import { buildRealDemoRequest, createRealDemoAgent, printStreamChunk, requireRealAgentEnv } from "./shared/real-demo";

async function run() {
  const { useOpenRouter } = requireRealAgentEnv();
  const agent = createRealDemoAgent({
    useOpenRouter,
    confirmationMode: "terminal",
  });

  console.log("=== Agent.run（高层 managed runtime 入口）===\n");
  console.log(`provider: ${useOpenRouter ? "openrouter/openai" : "minimax"}`);
  console.log("状态: 已发起真实模型请求，正在等待首个流式 chunk...\n");

  let sawFirstChunk = false;
  const waitingHint = setTimeout(() => {
    if (!sawFirstChunk) {
      console.log("提示: 还没收到首个 token，这通常意味着当前还在等待上游模型响应。");
      console.log("如果你想先验证 SDK 行为，可改跑 `demo:agent-resume` 或 `demo:agent-server`。\n");
    }
  }, 5000);

  const out = await agent.run(buildRealDemoRequest(useOpenRouter), {
    onStreamChunk: (chunk) => {
      sawFirstChunk = true;
      printStreamChunk(chunk);
    },
  });
  clearTimeout(waitingHint);

  console.log("\n--- 最终状态 ---");
  console.log({
    runId: out.runId,
    status: out.status,
    finishReason: out.finishReason,
    llmRounds: out.llmRounds,
    stopReason: out.stopReason,
  });
}

run().catch(console.error);
