/**
 * 06-error-handling.ts — Error handling patterns
 *
 * Run:  pnpm demo:error-handling
 * Env:  (uses invalid key to trigger errors)
 */
import {
  generateText,
  openai,
  LLMError,
  toPublicMessage,
  resetDefaultClient,
} from "@renx/provider";

async function main() {
  // --- Catch and classify errors ---
  console.log("=== Error Handling Demo ===\n");

  // 1) Invalid API key → UNAUTHORIZED
  console.log("--- Trigger UNAUTHORIZED (bad key) ---");
  resetDefaultClient();
  try {
    await generateText(
      { model: openai("gpt-4o-mini"), prompt: "test" },
      {
        vendors: ["openai", "anthropic"],
        apiKeys: { openai: "sk-invalid-key-12345" },
        useEnv: false,
      },
    );
  } catch (e) {
    if (LLMError.isInstance(e)) {
      console.log(`Error code:    ${e.code}`);
      console.log(`Vendor:        ${e.vendor}`);
      console.log(`Retryable:     ${e.retryable}`);
      console.log(`User message:  ${toPublicMessage(e.code)}`);
    } else {
      console.error("Unexpected error:", e);
    }
  }

  // 2) Model not found
  console.log("\n--- Trigger error with non-existent model ---");
  resetDefaultClient();
  try {
    await generateText({
      model: openai("nonexistent-model-xyz"),
      prompt: "test",
    });
  } catch (e) {
    if (LLMError.isInstance(e)) {
      console.log(`Error code:    ${e.code}`);
      console.log(`User message:  ${toPublicMessage(e.code)}`);
    }
  }

  // 3) Check retryable flag
  console.log("\n--- Retryable check pattern ---");
  try {
    await generateText({
      model: openai("gpt-4o-mini"),
      prompt: "test",
      retry: { maxAttempts: 2 },
    });
  } catch (e) {
    if (LLMError.isInstance(e)) {
      if (e.retryable) {
        console.log(`Retryable error (${e.code}) — safe to retry`);
      } else {
        console.log(`Non-retryable error (${e.code}) — do not retry`);
      }
    }
  }
}

main().catch(console.error);
