import type { AdapterInvokeContext } from "../adapter";
import type { CanonicalRequest } from "../types";

export function bytes(s: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(s));
      controller.close();
    },
  });
}

export const minimalReq: CanonicalRequest = {
  modelId: "m",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  params: {},
};

export const openaiCtx = (fetchImpl: typeof fetch): AdapterInvokeContext => ({
  fetch: fetchImpl,
  apiKey: "k",
  vendorId: "openai",
});
