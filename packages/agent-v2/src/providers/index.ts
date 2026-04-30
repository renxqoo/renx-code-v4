/**
 * Provider Bridge — adapts @renx/provider LLMClient to agent-v2 LLMClient.
 *
 * Bridges canonical types from @renx/provider (LLMClient, CanonicalMessage,
 * CanonicalStreamChunk, etc.) to agent-v2's internal LLMChunk / LLMClient
 * interface, so demos and real apps can use live AI backends.
 */
import type { Message } from "../message.js";
import type { LLMClient, LLMStreamGenerator, LLMChunk } from "../llm-client.js";
import type { LLMStreamRequest } from "../llm-client.js";

// Import actual provider types so callers can pass a real provider LLMClient.
import type {
  LLMClient as ProviderLLMClient,
  CanonicalMessage,
  CanonicalStreamChunk,
  MessagePart,
} from "@renx/provider";

// ── Message conversion: agent-v2 Message → provider CanonicalMessage ─

function agentV2MessageToCanonical(msg: Message): CanonicalMessage {
  switch (msg.role) {
    case "system":
      return {
        role: "system",
        content: [{ type: "text", text: msg.content } satisfies MessagePart],
      };
    case "user": {
      if (typeof msg.content === "string") {
        return {
          role: "user",
          content: [{ type: "text", text: msg.content } satisfies MessagePart],
        };
      }
      return {
        role: "user",
        content: msg.content.map((b): MessagePart => {
          if (b.type === "text") return { type: "text", text: b.text };
          if (b.type === "image") return { type: "image_url", url: b.url };
          return { type: "tool_result", toolCallId: b.toolCallId, content: b.content };
        }),
      };
    }
    case "assistant": {
      const parts: MessagePart[] = [];
      if (msg.content) parts.push({ type: "text", text: msg.content });
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          parts.push({
            type: "tool_call",
            id: tc.id,
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          });
        }
      }
      return { role: "assistant", content: parts };
    }
    case "tool":
      return {
        role: "tool",
        content: [
          { type: "tool_result", toolCallId: msg.toolCallId, content: msg.content },
        ],
      };
  }
}

// ── Chunk-level adaptation: provider CanonicalStreamChunk → agent-v2 LLMChunk ──

async function* adaptChunks(
  textStream: AsyncIterable<CanonicalStreamChunk>,
): LLMStreamGenerator {
  const idxMap = new Map<number, { id: string; name: string; buf: string }>();

  for await (const chunk of textStream) {
    switch (chunk.type) {
      case "text-delta":
        yield { type: "text-delta", delta: chunk.textDelta } satisfies LLMChunk;
        break;

      case "reasoning-delta":
        yield { type: "text-delta", delta: chunk.reasoningDelta } satisfies LLMChunk;
        break;

      case "tool-call-delta": {
        let entry = idxMap.get(chunk.index);
        if (!entry) {
          entry = { id: "", name: "", buf: "" };
          idxMap.set(chunk.index, entry);
        }
        if (chunk.id) {
          entry.id = chunk.id;
        }
        if (chunk.name) {
          entry.name = chunk.name;
        }
        if (chunk.argumentsDelta !== undefined) {
          if (entry.id && entry.name) {
            yield {
              type: "tool-call-delta",
              id: entry.id,
              name: entry.name,
              argsDelta: chunk.argumentsDelta,
            } satisfies LLMChunk;
          } else {
            entry.buf += chunk.argumentsDelta;
          }
          // Flush buffered args after id+name are set
          if (entry.id && entry.name && entry.buf) {
            yield {
              type: "tool-call-delta",
              id: entry.id,
              name: entry.name,
              argsDelta: entry.buf,
            } satisfies LLMChunk;
            entry.buf = "";
          }
        }
        break;
      }

      case "finish":
        yield {
          type: "finish",
          finishReason: chunk.finishReason,
          usage: {
            input: chunk.usage?.inputTokens ?? 0,
            output: chunk.usage?.outputTokens ?? 0,
            total: chunk.usage?.totalTokens,
          },
        } satisfies LLMChunk;
        break;
    }
  }
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Wrap a @renx/provider LLMClient as an agent-v2 LLMClient.
 *
 * The returned client translates agent-v2's `stream()` request shape into
 * provider's `streamText()` and converts canonical stream chunks back
 * to agent-v2 `LLMChunk` events.
 *
 * Usage:
 *   import { createDefaultLLMClient, openai } from "@renx/provider";
 *   import { createProviderBridge } from "@renx/agent-v2/providers";
 *
 *   const providerClient = createDefaultLLMClient({ vendors: ["openai"] });
 *   const agentClient = createProviderBridge(providerClient);
 *   setDefaultLLMClient(agentClient);
 */
export function createProviderBridge(providerClient: ProviderLLMClient): LLMClient {
  return {
    stream: async function* (request: LLMStreamRequest): LLMStreamGenerator {
      const result = await providerClient.streamText({
        model: request.model,
        messages: request.messages.map(agentV2MessageToCanonical),
        systemPrompt: request.systemPrompt,
        temperature: request.temperature,
        maxOutputTokens: request.maxTokens,
        topP: request.topP,
        stopSequences: request.stopSequences,
        tools: request.tools?.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters as Record<string, unknown>,
        })),
        toolChoice: request.tools?.length ? "auto" : undefined,
      });

      yield* adaptChunks(result.textStream);
    },
  };
}
