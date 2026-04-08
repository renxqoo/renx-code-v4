import type { CanonicalVideoJobStatus } from "../types";

/**
 * Create a `(rawStatus: string) => CanonicalVideoJobStatus` function from a
 * vendor-specific mapping table.
 *
 * ```ts
 * const mapOpenAIStatus = createStatusMapper({
 *   queued: "queued",
 *   in_progress: "in_progress",
 *   completed: "completed",
 *   failed: "failed",
 * });
 * ```
 */
export function createStatusMapper(
  mapping: Record<string, CanonicalVideoJobStatus>,
  fallback: CanonicalVideoJobStatus = "other",
): (raw: string) => CanonicalVideoJobStatus {
  return (raw) => mapping[raw] ?? fallback;
}
