/**
 * Structured logging interface for the Agent runtime.
 * Inject via `AgentConstructorConfig.logger` to capture lifecycle events
 * without coupling to any specific logging library.
 */
export interface AgentLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** No-op logger — all calls are discarded. */
export const noopLogger: AgentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** Logger that writes to `console` methods. */
export const consoleLogger: AgentLogger = {
  debug(message, meta) {
    console.debug(`[agent] ${message}`, meta ?? "");
  },
  info(message, meta) {
    console.info(`[agent] ${message}`, meta ?? "");
  },
  warn(message, meta) {
    console.warn(`[agent] ${message}`, meta ?? "");
  },
  error(message, meta) {
    console.error(`[agent] ${message}`, meta ?? "");
  },
};
