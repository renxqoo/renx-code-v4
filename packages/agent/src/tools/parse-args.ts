/** 解析模型返回的 `CanonicalToolCall.arguments`（JSON 字符串）。 */
export function parseToolCallArguments(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  try {
    const v = JSON.parse(trimmed) as unknown;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}
