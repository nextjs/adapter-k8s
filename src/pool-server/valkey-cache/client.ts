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
 * speaks to it directly (a bundled Valkey `StatefulSet` would work the same way — the handler only
 * ever sees this connection).
 *
 * N77 — the endpoint must be a SINGLE endpoint, not a Redis Cluster. This client implements no
 * `MOVED`/`ASK` redirection, so against a multi-shard deployment every command for a non-local slot
 * comes back as an error. What the CLI actually provisions is **Memorystore for Redis**, which
 * exposes one endpoint (including in its HA tier) — that is why this works. This comment used to
 * name *Memorystore for Valkey*, which is cluster-only and therefore the one Google product this
 * code cannot talk to; the mismatch mattered because a `-MOVED` reply used to surface as a plain
 * `RespError` straight into the handlers' catch blocks, i.e. a permanently dead cache with no
 * signal. `resp-client.ts` now logs a `MOVED`/`ASK` reply loudly (once) instead.
 *
 * The client connects lazily on first command, so importing the handler never blocks pool
 * bootstrap, and a brief Valkey blip surfaces as a rejected command (which the handler catches and
 * degrades to a cache miss) rather than hanging a render.
 */
export function createValkeyClient(config: ValkeyConfig): ValkeyClient {
  return createRespClient({ url: config.url, password: config.password, caCert: config.caCert });
}
