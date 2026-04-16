import type { CanonicalStreamChunk } from "@renx/provider";

/**
 * `streamText` 的 `text` / `finishReason` / `toolCalls` 等 Promise 由内部 async generator 在消费 `textStream` 时推进；
 * 若不迭代 `textStream`，这些 Promise 不会 resolve。调用方在读取字段前必须先排空流。
 */
export async function drainTextStream(
  stream: AsyncIterable<CanonicalStreamChunk>,
  onChunk?: (chunk: CanonicalStreamChunk) => void | Promise<void>,
): Promise<void> {
  for await (const chunk of stream) {
    if (onChunk) {
      await Promise.resolve(onChunk(chunk));
    }
  }
}
