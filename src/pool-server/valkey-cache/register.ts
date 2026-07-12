import { createValkeyClient, type ValkeyConfig } from "./client.js";
import { ValkeyCacheHandler } from "./use-cache-handler.js";

/**
 * The global slot Next reads its `use cache` handlers from. Next's `initializeCacheHandlers`
 * reads `.DefaultCache` / `.RemoteCache` off this object exactly ONCE, and only if it hasn't
 * already initialized — so this MUST run before the app module loads (before the first
 * `use cache` / server init). See next/dist/server/use-cache/handlers.js.
 */
const CACHE_HANDLERS_SYMBOL = Symbol.for("@next/cache-handlers");

export interface RegisterOptions extends ValkeyConfig {
  buildId: string;
}

/**
 * Install the Valkey-backed handler as both the default and remote `use cache` handler, so
 * every `use cache` entry (default or `remote` profile) is shared across replicas. Returns
 * the handler for tests / lifecycle management.
 */
export function registerValkeyCacheHandler(options: RegisterOptions): ValkeyCacheHandler {
  const client = createValkeyClient(options);
  const handler = new ValkeyCacheHandler({ client, buildId: options.buildId });
  const reference = globalThis as Record<symbol, unknown>;
  const existing =
    (reference[CACHE_HANDLERS_SYMBOL] as
      | { DefaultCache?: unknown; RemoteCache?: unknown }
      | undefined) ?? {};
  reference[CACHE_HANDLERS_SYMBOL] = {
    ...existing,
    DefaultCache: handler,
    RemoteCache: handler,
  };
  return handler;
}
