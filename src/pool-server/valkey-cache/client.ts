import { createRespClient, type ValkeyClient } from "./resp-client.js";

export type { ValkeyClient } from "./resp-client.js";

export interface ValkeyConfig {
  /** Connection URL, e.g. `redis://host:6379` or `rediss://host:6380` (TLS). */
  url: string;
  /** AUTH string (e.g. the Memorystore auth string), optional. */
  password?: string | undefined;
  /** PEM of the server CA for TLS verification (e.g. Memorystore in-transit encryption). */
  caCert?: string | undefined;
}

/**
 * Create the shared Valkey connection. Valkey is wire-compatible with Redis, so our RESP2 client
 * speaks to it directly (GKE → Memorystore-for-Valkey now; a bundled Valkey `StatefulSet` later —
 * the handler only ever sees this connection).
 *
 * The client connects lazily on first command, so importing the handler never blocks pool
 * bootstrap, and a brief Valkey blip surfaces as a rejected command (which the handler catches and
 * degrades to a cache miss) rather than hanging a render.
 */
export function createValkeyClient(config: ValkeyConfig): ValkeyClient {
  return createRespClient({ url: config.url, password: config.password, caCert: config.caCert });
}
