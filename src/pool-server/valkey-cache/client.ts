import { Redis, type RedisOptions } from "ioredis";

export interface ValkeyConfig {
  /** Connection URL, e.g. `redis://host:6379` or `rediss://host:6380` (TLS). */
  url: string;
  /** AUTH string (e.g. the Memorystore auth string), optional. */
  password?: string;
}

/**
 * Create the shared Valkey connection. Valkey is wire-compatible with Redis, so ioredis
 * speaks to it directly (GKE → Memorystore-for-Valkey now; a bundled Valkey `StatefulSet`
 * later — the handler only ever sees this connection).
 *
 * `lazyConnect` defers the socket until first use so importing the handler never blocks pool
 * bootstrap. `maxRetriesPerRequest` is bounded so a brief Valkey blip surfaces as a rejected
 * command (which the handler catches and degrades to a cache miss) rather than hanging a
 * render.
 */
export function createValkeyClient(config: ValkeyConfig): Redis {
  const options: RedisOptions = {
    lazyConnect: true,
    enableAutoPipelining: true,
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  };
  if (config.password) options.password = config.password;
  return new Redis(config.url, options);
}
