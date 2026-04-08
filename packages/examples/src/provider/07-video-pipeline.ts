/**
 * 07-video-pipeline.ts — Video generation with polling
 *
 * Run:  pnpm demo:video
 * Env:  OPENAI_API_KEY=sk-... (OpenAI) or MINIMAX_API_KEY=... (MiniMax)
 *
 * This demo shows the full video pipeline:
 *   generateVideo → poll getVideoJob → downloadVideo
 */
import { writeFileSync } from "node:fs";
import {
  generateVideo,
  getVideoJob,
  downloadVideo,
  openai,
  type ModelHandle,
  LLMError,
} from "@renx/provider";

const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 60;

async function pollUntilDone(
  model: string | ModelHandle,
  videoId: string,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const job = await getVideoJob({ model, videoId });
    console.log(
      `[${new Date().toISOString()}] status=${job.status}` +
        (job.progress != null ? ` progress=${Math.round(job.progress * 100)}%` : ""),
    );

    if (job.status === "completed") {
      console.log("Video generation completed!");
      return job.fileId;
    }

    if (job.status === "failed") {
      throw new Error(`Video generation failed: ${job.error ?? "unknown"}`);
    }

    // Wait before next poll
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error("Polling timed out");
}

async function main() {
  // Switch vendor by uncommenting one:
  const model = openai("gpt-4o-mini-video"); // OpenAI
  // const model = minimax("MiniMax-Hailuo-2.3");     // MiniMax

  console.log("=== Generate Video ===");
  const { videoId, status } = await generateVideo({
    model,
    prompt: "A cat walking through a garden in slow motion",
    size: "768P",
    seconds: 5,
  });
  console.log(`Video ID: ${videoId}, initial status: ${status}`);

  // Poll until done
  const fileId = await pollUntilDone(model, videoId);

  // Download
  console.log("\n=== Download Video ===");
  const video = await downloadVideo({ model, videoId, fileId });
  const outPath = "demo-output.mp4";
  writeFileSync(outPath, video.data);
  console.log(`Video saved to ${outPath} (${video.data.length} bytes)`);
  console.log(`Content-Type: ${video.contentType}`);
}

main().catch((e) => {
  if (LLMError.isInstance(e)) {
    console.error(`[${e.code}] ${e.message} (vendor=${e.vendor}, retryable=${e.retryable})`);
  } else {
    console.error(e);
  }
});
