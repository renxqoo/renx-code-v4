export type ParseToolCallResult = {
  ok: boolean;
  args: Record<string, unknown>;
  parseError?: string;
};

/** 解析模型返回的 `CanonicalToolCall.arguments`（JSON 字符串）。 */
export function parseToolCallArguments(raw: string): ParseToolCallResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true, args: {} };
  }
  try {
    const v = JSON.parse(trimmed) as unknown;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      return { ok: true, args: v as Record<string, unknown> };
    }
    return { ok: false, args: {}, parseError: `Parsed value is not a JSON object: ${typeof v}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, args: {}, parseError: message };
  }
}
