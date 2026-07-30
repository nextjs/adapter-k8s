// The module registered via `next.config.cacheHandler`. Next constructs it (with the
// IncrementalCache ctx) during `next build`, at runtime in the pool, AND may bundle it into edge
// chunks (edge routes/pages). So this module must EVALUATE cleanly in every runtime — including
// edge, which has no node internals. The Valkey client (`node:net`/`node:tls`) loads those built-ins
// lazily via dynamic import inside `connect()`, and Next's file-system cache is `require`d lazily
// inside the constructor, so importing this module pulls in no node internals at eval.
//
//   - Runtime in the pool: VALKEY_URL + NEXT_BUILD_ID are set → back the incremental cache with
//     Valkey (shared across replicas → cross-replica PPR shell + ISR revalidation).
//   - `next build` / local / cache-disabled: those env vars are absent → delegate to Next's own
//     file-system cache, so behavior matches a build with no custom handler.
//   - edge runtime: the `EdgeRuntime` guard in the constructor returns an inert delegate, so
//     `connect()` (and thus `node:net`) is never reached there.
//
// `ValkeyIncrementalCacheHandler` and `createValkeyClient` are import-safe (no node internals at
// module eval), so importing them statically is fine in any runtime.
import { ValkeyIncrementalCacheHandler } from "./incremental-cache-handler.js";
import { createValkeyClient } from "./client.js";
import { createBuildSeedLookup } from "./build-seed-index.js";

// `require` is available because this module is bundled to CJS. Next's file-system cache is required
// lazily (inside the constructor) so this module evaluates without it in edge/build runtimes.
declare const require: (id: string) => any;

// One Valkey handler per process, shared across every IncrementalCache instance.
let sharedHandler: ValkeyIncrementalCacheHandler | undefined;

/** N82: set once the build id was rejected, so the fallback is taken without re-logging. */
let buildIdRejected = false;

function getValkeyHandler(): ValkeyIncrementalCacheHandler | undefined {
  const url = process.env.VALKEY_URL;
  const buildId = process.env.NEXT_BUILD_ID;
  if (!url || !buildId || buildIdRejected) return undefined;
  if (!sharedHandler) {
    // Lazy: only reached in the node pool runtime when a cache is configured. Never in edge.
    const client = createValkeyClient({
      url,
      password: process.env.VALKEY_AUTH,
      caCert: process.env.VALKEY_CA_CERT,
    });
    try {
      sharedHandler = new ValkeyIncrementalCacheHandler({
        client,
        buildId,
        // Warm-start parity with `next start` (see build-seed-index.ts): a Valkey miss
        // consults the on-disk build prerender before reporting a miss to Next.
        seedLookup: createBuildSeedLookup(),
      });
    } catch (error) {
      // N82: the constructor asserts the build id's charset (a `:` would let one build's keys
      // alias another's). This runs inside Next's `cacheHandler` construction, i.e. during a
      // render, so it must not throw out of here — but it must be LOUD and it must NOT fall back
      // to a shared keyspace. Declining the Valkey handler entirely leaves the file-system cache,
      // which is per-pod and therefore safe.
      buildIdRejected = true;
      console.error(
        "[valkey-cache] NEXT_BUILD_ID is unsafe for the Valkey cache keyspace; the shared cache " +
          "is DISABLED for this process and each pod falls back to its local file-system cache",
        error instanceof Error ? error.message : String(error),
      );
      return undefined;
    }
  }
  return sharedHandler;
}

interface Delegate {
  get(cacheKey: string, ctx: unknown): Promise<unknown>;
  set(cacheKey: string, data: unknown, ctx: unknown): Promise<void>;
  revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void>;
  resetRequestCache?(): void;
}

export default class CacheHandler {
  private readonly impl: Delegate;

  constructor(ctx: unknown) {
    // Next constructs the cacheHandler in EVERY runtime that touches the incremental cache —
    // including the edge runtime (edge routes/pages), where neither ioredis nor Next's file-system
    // cache can be required. Detect edge (Next sets `globalThis.EdgeRuntime`) and use an inert
    // delegate: edge output simply doesn't participate in the shared cache (a miss → Next renders),
    // which is safe. The node pool is where the Valkey-backed sharing actually happens.
    if (typeof (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime !== "undefined") {
      this.impl = {
        get: async () => null,
        set: async () => undefined,
        revalidateTag: async () => undefined,
        resetRequestCache: () => undefined,
      };
      return;
    }
    const valkey = getValkeyHandler();
    if (valkey) {
      this.impl = valkey as unknown as Delegate;
    } else {
      // Fall back to Next's file-system cache (build time / local / cache disabled). Lazy-required
      // so this module never pulls node internals at eval (edge).
      const FileSystemCache =
        require("next/dist/server/lib/incremental-cache/file-system-cache").default;
      this.impl = new FileSystemCache(ctx);
    }
  }

  get(cacheKey: string, ctx: unknown): Promise<unknown> {
    return this.impl.get(cacheKey, ctx);
  }
  set(cacheKey: string, data: unknown, ctx: unknown): Promise<void> {
    return this.impl.set(cacheKey, data, ctx);
  }
  revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void> {
    return this.impl.revalidateTag(tags, durations);
  }
  resetRequestCache(): void {
    this.impl.resetRequestCache?.();
  }
}
