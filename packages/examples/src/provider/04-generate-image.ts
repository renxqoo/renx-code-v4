/**
 * 04-generate-image.ts — Image generation
 *
 * Run:  pnpm demo:generate-image
 * Env:  OPENAI_API_KEY=sk-...
 */
import { generateImage, minimax } from "@renx/provider";

async function main() {
  const result = await generateImage({
    model: minimax("image-01"),
    prompt: "女孩在海底捞的窗户前，看向火锅里的肥牛，快要流口水了",
    size: "1:1",
    n: 1,
  });

  for (const [i, img] of result.images.entries()) {
    if (img.url) {
      console.log(`Image ${i + 1} URL: ${img.url}`);
    }
    if (img.b64Json) {
      console.log(`Image ${i + 1} base64 length: ${img.b64Json.length}`);
    }
    if (img.revisedPrompt) {
      console.log(`Revised prompt: ${img.revisedPrompt}`);
    }
  }
}

main().catch(console.error);
