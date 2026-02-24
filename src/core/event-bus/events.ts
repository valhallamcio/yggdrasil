// Every internal domain event is defined here as a discriminated union.
// Adding a new event: extend this union + subscribe in the relevant plugin/service.
// This file is the single source of truth for all async internal communication.

export interface ServerStatsPayload {
  memory_bytes: number;
  memory_limit_bytes: number;
  cpu_absolute: number;
  network: { rx_bytes: number; tx_bytes: number };
  uptime: number;
  state: string;
  disk_bytes: number;
}

export type AppEvent =
  | { type: 'webhook.inbound'; payload: { provider: string; body: unknown; headers: Record<string, string> } }
  | { type: 'webhook.outbound.request'; payload: { url: string; data: unknown; retries?: number } }
  | { type: 'scheduler.job.completed'; payload: { jobId: string; durationMs: number } }
  | { type: 'scheduler.job.failed'; payload: { jobId: string; error: string } }
  | { type: 'donation.received'; payload: { channelId: string; message: string } }
  | { type: 'server.stats'; payload: { server: string; stats: ServerStatsPayload } }
  | { type: 'server.state.changed'; payload: { server: string; serverName: string; previousState: string; currentState: string } }
  | { type: 'server.crashed'; payload: { server: string; serverName: string; previousState: string; currentState: string; reason: string } }
  | { type: 'server.recovered'; payload: { server: string; serverName: string } }
  | { type: 'server.console.output'; payload: { server: string; line: string } };

export type AppEventType = AppEvent['type'];
export type AppEventPayload<T extends AppEventType> = Extract<AppEvent, { type: T }>['payload'];
