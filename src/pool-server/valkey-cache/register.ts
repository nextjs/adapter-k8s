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
/**
 * Slots Next's `initializeCacheHandlers` materializes FROM the seed above, on first use:
 * the kind→handler map and the deduped handler set that `getCacheHandlers()` iterates.
 */
const CACHE_HANDLERS_MAP_SYMBOL = Symbol.for("@next/cache-handlers-map");
const CACHE_HANDLERS_SET_SYMBOL = Symbol.for("@next/cache-handlers-set");

/**
 * Mirror the node-side `use cache` handler registry onto an edge-sandbox `globalThis`.
 *
 * The sandbox is a separate realm: its copy of next's use-cache/handlers.js reads these
 * Symbol.for slots off ITS OWN globalThis, which starts empty — so an edge-runtime
 * `after()` calling revalidatePath/revalidateTag found no handlers and the write vanished
 * (edge-middleware apps register no classic cacheHandler either, so there was no fallback;
 * measured live on k3d, next-after-app-deploy, all 4 edge cases + both middleware cases).
 * Symbol.for is isolate-wide, so assigning the same objects here hands the sandbox realm
 * the node side's actual handlers: tag writes and `use cache` entries then share one
 * Valkey-backed store cross-realm, matching what node routes already do.
 *
 * Must run BEFORE the entry modules are evaluated in the context — a realm that already
 * self-initialized from an empty seed keeps its private default handler forever.
 */
export function seedSandboxCacheHandlerRegistry(sandboxGlobal: Record<symbol, unknown>): void {
  const reference = globalThis as Record<symbol, unknown>;
  for (const sym of [CACHE_HANDLERS_SYMBOL, CACHE_HANDLERS_MAP_SYMBOL, CACHE_HANDLERS_SET_SYMBOL]) {
    if (reference[sym] !== undefined) sandboxGlobal[sym] = reference[sym];
  }
}

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
