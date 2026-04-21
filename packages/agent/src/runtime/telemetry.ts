export type AgentTelemetryEvent = {
  name:
    | "run_created"
    | "run_started"
    | "run_waiting"
    | "run_finished"
    | "run_cancelled"
    | "model_completed"
    | "tool_completed"
    | "lease_acquired"
    | "lease_renewed"
    | "lease_released"
    | "worker_cycle"
    | "worker_error";
  at: string;
  runId?: string;
  ownerId?: string;
  llmRound?: number;
  status?: string;
  finishReason?: string;
  durationMs?: number;
  toolCount?: number;
  success?: boolean;
  metadata?: Record<string, unknown>;
};

export interface AgentTelemetrySink {
  capture(event: AgentTelemetryEvent): Promise<void> | void;
}

export const noopTelemetry: AgentTelemetrySink = {
  capture() {},
};
