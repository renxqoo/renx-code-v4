/**
 * Shared path resolution for renx-code file storage.
 *
 * All local data (sessions, memory, cache, etc.) is stored under
 * `$HOME/.renx-code/` by default. Override with the `RENX_DATA_DIR`
 * environment variable.
 */
import { homedir } from "node:os";
import { join } from "node:path";

const RENX_DIR_NAME = ".renx-code";

/**
 * Root data directory for all renx-code persisted files.
 * Default: `$HOME/.renx-code/`
 * Override: `RENX_DATA_DIR` env var
 */
export function renxDataDir(): string {
  if (process.env.RENX_DATA_DIR) return process.env.RENX_DATA_DIR;
  return join(homedir(), RENX_DIR_NAME);
}

/**
 * Directory for conversation session JSONL files.
 * Default: `$HOME/.renx-code/sessions/`
 * Override: `RENX_SESSIONS_DIR` env var (falls back to `{renxDataDir()}/sessions`)
 */
export function renxSessionsDir(custom?: string): string {
  if (custom) return custom;
  if (process.env.RENX_SESSIONS_DIR) return process.env.RENX_SESSIONS_DIR;
  return join(renxDataDir(), "sessions");
}
