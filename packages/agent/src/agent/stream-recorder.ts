import type { CanonicalStreamChunk } from "@renx/provider";
import type { QueryStreamChunkMeta } from "./types";

export type StreamRecorder = {
  /** 直接作为 `queryModel` 的 `onStreamChunk` 传入。 */
  onStreamChunk: (
    chunk: CanonicalStreamChunk,
    meta: QueryStreamChunkMeta,
  ) => Promise<void>;
  /** 当前累计的 assistant 正文增量（仅 `text-delta` 拼接）。 */
  getTextAccumulated: () => string;
  /** 当前累计的 reasoning 文本（若提供商带 reasoning stream）。 */
  getReasoningAccumulated: () => string;
  /** 清空文本累积（例如在 `beforeFinish` 存盘后、或每轮开始时若你希望按轮分割）。 */
  resetText: () => void;
  /** 若构造时 `keepChunks: true`，返回已收集的 chunk 副本。 */
  getChunks: () => CanonicalStreamChunk[];
};

export type CreateStreamRecorderOptions = {
  /** 是否保留每一份 `CanonicalStreamChunk`（更占内存，便于回放/审计）。默认只累加文本。 */
  keepChunks?: boolean;
  /**
   * 额外回调，例如打印到终端；会在累加/收集之后调用。
   * `meta.suppressOutput === true` 时若你只关心落库可仍处理 chunk。
   */
  tap?: (
    chunk: CanonicalStreamChunk,
    meta: QueryStreamChunkMeta,
  ) => void | Promise<void>;
};

/**
 * 收集流式输出（不进 enterprise hook 生命周期）；
 * 结构化审计建议走 `createAuditHook()`，流式原文可由本类按轮或按次落库。
 */
export function createStreamRecorder(options?: CreateStreamRecorderOptions): StreamRecorder {
  let text = "";
  let reasoning = "";
  const chunks: CanonicalStreamChunk[] = [];
  const keepChunks = options?.keepChunks === true;

  const onStreamChunk = async (
    chunk: CanonicalStreamChunk,
    meta: QueryStreamChunkMeta,
  ): Promise<void> => {
    if (keepChunks) {
      chunks.push(chunk);
    }
    switch (chunk.type) {
      case "text-delta":
        text += chunk.textDelta;
        break;
      case "reasoning-delta":
        reasoning += chunk.reasoningDelta;
        break;
      default:
        break;
    }
    if (options?.tap) {
      await Promise.resolve(options.tap(chunk, meta));
    }
  };

  return {
    onStreamChunk,
    getTextAccumulated: () => text,
    getReasoningAccumulated: () => reasoning,
    resetText: () => {
      text = "";
      reasoning = "";
      chunks.length = 0;
    },
    getChunks: () => [...chunks],
  };
}
