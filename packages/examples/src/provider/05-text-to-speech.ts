/**
 * 05-text-to-speech.ts — Text-to-speech and transcription
 *
 * Run:  pnpm demo:tts
 * Env:  OPENAI_API_KEY=sk-...
 */
import { writeFileSync } from "node:fs";
import { textToSpeech, transcribe, openai } from "@renx/provider";

async function main() {
  // --- Text-to-Speech ---
  console.log("=== Text-to-Speech ===");
  const ttsResult = await textToSpeech({
    model: openai("tts-1"),
    text: "Hello! This is a demo of the Renx provider text-to-speech.",
    voice: "alloy",
    format: "mp3",
  });

  const outPath = "demo-output.mp3";
  writeFileSync(outPath, ttsResult.audio);
  console.log(`Audio saved to ${outPath} (${ttsResult.audio.length} bytes)`);
  console.log(`Content-Type: ${ttsResult.contentType}`);

  // --- Transcription ---
  console.log("\n=== Transcription ===");
  const transcription = await transcribe({
    model: openai("whisper-1"),
    audio: ttsResult.audio,
    filename: "demo-output.mp3",
    language: "en",
  });

  console.log(`Transcribed text: ${transcription.text}`);
  if (transcription.durationSeconds) {
    console.log(`Duration: ${transcription.durationSeconds}s`);
  }
}

main().catch(console.error);
