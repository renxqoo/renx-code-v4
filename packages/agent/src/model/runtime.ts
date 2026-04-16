import type {
  CanonicalFinishReason,
  CanonicalStreamChunk,
  CanonicalToolCall,
  CanonicalUsage,
  StreamTextResult,
} from "@renx/provider";
import { streamText } from "@renx/provider";
import type { QueryModelType } from "../domain/query-model";

async function* emptyTextStream(): AsyncGenerator<CanonicalStreamChunk> {}

function erroredStreamTextResult(error: unknown): StreamTextResult {
  return {
    textStream: emptyTextStream(),
    text: Promise.resolve(""),
    reasoning: Promise.resolve(""),
    toolCalls: Promise.resolve([]),
    usage: Promise.resolve(undefined),
    finishReason: Promise.resolve("error"),
  };
}

export type RuntimeOk = { ok: true } & StreamTextResult;

export type RuntimeErr = {
  ok: false;
  error: unknown;
  textStream: AsyncIterable<CanonicalStreamChunk>;
  text: Promise<string>;
  reasoning: Promise<string>;
  toolCalls: Promise<CanonicalToolCall[]>;
  usage: Promise<CanonicalUsage | undefined>;
  finishReason: Promise<CanonicalFinishReason>;
};

export type RuntimeOutcome = RuntimeOk | RuntimeErr;

export async function runtime(config: QueryModelType): Promise<RuntimeOutcome> {
  try {
    const result = await streamText(config);
    return { ok: true, ...result };
  } catch (err) {
    console.error(err);
    const fallback = erroredStreamTextResult(err);
    return {
      ok: false,
      error: err,
      ...fallback,
    };
  }
}
