import type { CanonicalTool } from "@renx/provider";

/**
 * 合并注册表工具与调用方额外工具；同名以 registry 为准（后写入覆盖）。
 */
export function mergeCanonicalTools(
  registryTools: CanonicalTool[],
  extra?: CanonicalTool[],
): CanonicalTool[] | undefined {
  const byName = new Map<string, CanonicalTool>();
  for (const t of extra ?? []) {
    byName.set(t.name, t);
  }
  for (const t of registryTools) {
    byName.set(t.name, t);
  }
  const merged = [...byName.values()];
  return merged.length > 0 ? merged : undefined;
}
