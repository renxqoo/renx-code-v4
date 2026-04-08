/**
 * 11-minimax-tts.ts — MiniMax synchronous text-to-speech demo
 *
 * Run:  pnpm demo:minimax-tts
 * Env:  MINIMAX_API_KEY=...
 *
 * MiniMax TTS returns audio as a hex-encoded payload in a single response
 * (no streaming).  You can control voice, speed, format, and advanced
 * audio settings through providerOptions.
 */
import { writeFileSync } from "node:fs";
import { createDefaultLLMClient, minimax } from "@renx/provider";

async function main() {
  const client = createDefaultLLMClient({
    vendors: ["minimax"],
  });

  // --- Basic TTS with default voice ---
  console.log("=== MiniMax Text-to-Speech (default voice) ===");
  const result = await client.textToSpeech({
    model: minimax("speech-2.8-hd"),
    text: "只需告诉模型你想要什么主题——比如，歌词生成接口就会自动为你写出包含段落结构（Verse、Chorus、Bridge 等）的完整歌词。如果你已经有了歌词，可以跳过这一步。另外即使没有歌词也可以直接进入第二步，调用音乐生成接口，谱曲并生成完整歌曲。",
    format: "mp3",
  });

  const outPath = "demo-minimax-tts.mp3";
  writeFileSync(outPath, result.audio);
  console.log(`Audio saved to ${outPath} (${result.audio.length} bytes)`);
  console.log(`Content-Type: ${result.contentType}`);

  // // --- TTS with custom voice, speed, and advanced settings ---
  // console.log("\n=== MiniMax TTS (custom voice & settings) ===");
  // const result2 = await client.textToSpeech({
  //   model: minimax("speech-02-hd"),
  //   text: "This is a demo with a female voice and faster speed.",
  //   voice: "female-shaonv",
  //   speed: 1.2,
  //   format: "mp3",
  //   providerOptions: {
  //     audio_setting: {
  //       sample_rate: 44100,
  //       bitrate: 256000,
  //     },
  //   },
  // });

  // const outPath2 = "demo-minimax-tts-custom.mp3";
  // writeFileSync(outPath2, result2.audio);
  // console.log(`Audio saved to ${outPath2} (${result2.audio.length} bytes)`);
  // console.log(`Content-Type: ${result2.contentType}`);
}

main().catch(console.error);
