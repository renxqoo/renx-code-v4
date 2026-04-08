export async function readJsonOrText(res: Response): Promise<unknown> {
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    try {
      return await res.json();
    } catch {
      return await res.text();
    }
  }
  return await res.text();
}

/** Coerce an unknown value to `number | undefined` — used for token counts etc. */
export function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Decode a hex string (with or without `0x` prefix) into a `Uint8Array`.
 * Throws `Error` on odd-length input — callers can wrap in `LLMError` if needed.
 */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, "");
  if (clean.length % 2 !== 0) {
    throw new Error("Invalid hex string: odd length");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
