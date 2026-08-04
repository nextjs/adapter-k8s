// src/pool-server/handler-loader.ts
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";
import type { PoolManifest } from "../types.js";

export type ArtifactRouteHandler = (...args: unknown[]) => unknown;
type LoadedModule = Record<string, unknown>;
type LoadModuleFn = (entrypointPath: string) => Promise<LoadedModule>;

// Normalize a Turbopack _ENTRIES key (`middleware_app/api/edge/route`,
// `middleware_pages/api/foo`, `middleware_app/(group)/dashboard/page`) to the public
// route pathname it serves, so a route can select ITS OWN entry from the
// process-global registry. Returns null when the key doesn't look like a route entry.
function entryKeyToPathname(entryKey: string): string | null {
  let name = entryKey.startsWith("middleware_") ? entryKey.slice("middleware_".length) : entryKey;
  if (name.startsWith("app/") || name === "app") name = name.slice("app".length);
  else if (name.startsWith("pages/") || name === "pages") name = name.slice("pages".length);
  else return null;
  // Route groups `(group)` and parallel-route slots `@slot` are invisible in the URL.
  // N17: anchor both strips to a WHOLE segment. `(group)` and `@slot` are invisible in the URL,
  // but an interception marker is GLUED to its segment (`(...)post`, `(.)modal`) and must
  // survive — unanchored, `/foo/@modal/(...)post/[id]/page` collapsed to `/foo/[id]/page`, so
  // the interception route was never found AND the bogus key could shadow a real `/foo/[id]`.
  name = name.replace(/\/\([^/]*\)(?=\/|$)/g, "").replace(/\/@[^/]+(?=\/|$)/g, "");
  // App Router entries end in the file kind; the route itself is the dirname.
  name = name.replace(/\/(route|page)$/, "");
  if (!name.startsWith("/")) name = `/${name}`;
  return name === "/index" || name === "" ? "/" : name;
}

function routePathnamesEqual(a: string, b: string): boolean {
  const normalize = (p: string) => (p === "/index" || p === "" ? "/" : p);
  return normalize(a) === normalize(b);
}

// Same resolution order as AWS adapter: handler, default, default.handler, default.fetch, fetch
export function resolveRouteHandlerExport(
  module: LoadedModule,
  routePathname?: string,
): ArtifactRouteHandler {
  if (typeof module.handler === "function") return module.handler as ArtifactRouteHandler;
  if (typeof module.default === "function") return module.default as ArtifactRouteHandler;
  if (module.default && typeof module.default === "object") {
    const nested = module.default as Record<string, unknown>;
    if (typeof nested.handler === "function") return nested.handler as ArtifactRouteHandler;
    if (typeof nested.fetch === "function") return nested.fetch as ArtifactRouteHandler;
  }
  if (typeof module.fetch === "function") return module.fetch as ArtifactRouteHandler;

  // App Router route modules compiled by Turbopack may export routeModule with a handle method
  if (module.routeModule && typeof module.routeModule === "object") {
    const rm = module.routeModule as Record<string, unknown>;
    if (typeof rm.handle === "function") return rm.handle as ArtifactRouteHandler;
    if (typeof rm.render === "function") return rm.render as ArtifactRouteHandler;
  }

  // Edge runtime modules compiled by Turbopack register in globalThis._ENTRIES.
  // The registry is PROCESS-global and CUMULATIVE: once two edge modules are loaded
  // it holds both routes' entries, and taking "the" entry could resolve ANOTHER
  // route's handler. The keys embed the route's build path (e.g.
  // `middleware_app/api/edge/route`), so select the entry matching THIS route's
  // pathname. A pool with several edge routes must not 500 on the second one (the
  // old exactly-one gate did exactly that). Fall back to a lone registered entry
  // when the key format doesn't match (unambiguous); with genuine ambiguity — no
  // matching key among several entries, or several matching keys — fail loudly
  // (the throw below names the module's actual exports) rather than serve the
  // wrong route.
  const entries = (globalThis as Record<string, unknown>)._ENTRIES as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (entries) {
    const keys = Object.keys(entries);
    const fromEntry = (key: string): ArtifactRouteHandler | undefined => {
      const entry = entries[key];
      if (typeof entry?.default === "function") return entry.default as ArtifactRouteHandler;
      if (typeof entry?.handler === "function") return entry.handler as ArtifactRouteHandler;
      return undefined;
    };
    const matches = routePathname
      ? keys.filter((key) => {
          const keyPathname = entryKeyToPathname(key);
          return keyPathname !== null && routePathnamesEqual(keyPathname, routePathname);
        })
      : [];
    if (matches.length === 1) {
      const handler = fromEntry(matches[0]!);
      if (handler) return handler;
    } else if (matches.length === 0 && keys.length === 1) {
      const handler = fromEntry(keys[0]!);
      if (handler) return handler;
    }
  }

  const exportKeys = Object.keys(module);
  const exportTypes = exportKeys.map((k) => `${k}:${typeof module[k]}`).join(", ");
  // Also dump nested default keys if it's an object
  let defaultInfo = "";
  if (module.default && typeof module.default === "object") {
    const dk = Object.keys(module.default as Record<string, unknown>);
    const dt = dk
      .map((k) => `${k}:${typeof (module.default as Record<string, unknown>)[k]}`)
      .join(", ");
    defaultInfo = ` default={${dt}}`;
  }
  throw new Error(
    `Could not find a valid handler export (handler, default, fetch) in the module. ` +
      `Exports: [${exportTypes}]${defaultInfo}`,
  );
}

/**
 * Un-latch the route module's ResponseCache mode (the rdc stale-forever root cause):
 * `RouteModule.getResponseCache` lazily constructs `new ResponseCache(minimalMode)` ONCE
 * per instance (route-module.ts:1101), latching the FIRST request's mode for the process
 * lifetime — and this loader caches the module for the process lifetime. ResponseCache
 * skips the incremental-cache write under minimal mode (response-cache/index.ts:493), so a
 * pod whose first hit on a route was a MINIMAL document render never persisted a
 * background revalidation again: measured as resume-data-cache serving stale >12s on cold
 * pods while byte-identical request sequences passed on warmed ones. Replace the accessor
 * with one that keys a ResponseCache instance per MODE off the live request's meta —
 * minimal requests keep skip-write semantics (the platform owns those entries), and the
 * Batcher dedupe survives within each mode.
 */
function unlatchResponseCache(
  module: LoadedModule,
  ResponseCacheCtor: new (minimalMode: boolean) => unknown,
): void {
  const rm = (
    module as {
      routeModule?: { getResponseCache?: (req: unknown) => unknown };
    }
  ).routeModule;
  if (!rm || typeof rm.getResponseCache !== "function") return;
  const META = Symbol.for("NextInternalRequestMeta");
  const perMode = new Map<boolean, unknown>();
  rm.getResponseCache = (req: unknown): unknown => {
    const minimal = !!(
      req as { [key: symbol]: { minimalMode?: boolean } | undefined } | undefined
    )?.[META]?.minimalMode;
    let rc = perMode.get(minimal);
    if (!rc) {
      rc = new ResponseCacheCtor(minimal);
      perMode.set(minimal, rc);
    }
    return rc;
  };
}

/** Resolve Next's ResponseCache class through the APP's own next (the module graph the
 * entrypoints run in). Lazy and fail-open: an unresolvable class leaves the upstream
 * latch behavior untouched rather than breaking handler loading. */
function defaultResponseCacheCtor(): (new (minimalMode: boolean) => unknown) | undefined {
  try {
    const req = createRequire(path.resolve(process.cwd(), "package.json"));
    const mod = req("next/dist/server/response-cache") as {
      default?: new (minimalMode: boolean) => unknown;
    };
    return typeof mod.default === "function" ? mod.default : undefined;
  } catch {
    return undefined;
  }
}

export function createHandlerLoader(
  manifest: PoolManifest,
  loadModule: LoadModuleFn = (p) => import(pathToFileURL(path.resolve(process.cwd(), p)).href),
  options?: { responseCacheCtor?: new (minimalMode: boolean) => unknown },
) {
  let resolvedCtor: (new (minimalMode: boolean) => unknown) | undefined | null = null;
  const responseCacheCtor = (): (new (minimalMode: boolean) => unknown) | undefined => {
    if (options?.responseCacheCtor) return options.responseCacheCtor;
    if (resolvedCtor === null) resolvedCtor = defaultResponseCacheCtor();
    return resolvedCtor;
  };
  const cache = new Map<string, Promise<ArtifactRouteHandler>>();

  return {
    async load(outputId: string): Promise<ArtifactRouteHandler> {
      const cached = cache.get(outputId);
      if (cached) return cached;

      const output = manifest.outputs[outputId];
      if (!output) {
        throw new Error(`Unknown output ID: ${outputId} for pool ${manifest.poolName}`);
      }

      const promise = loadModule(output.filePath).then(
        async (module): Promise<ArtifactRouteHandler> => {
          // Turbopack modules with top-level await (e.g., Genkit, heavy async deps)
          // may export a Promise as module.exports. Await it to get the real exports.
          let resolved: LoadedModule = module;
          const defaultExport = module.default;
          if (defaultExport instanceof Promise) {
            resolved = (await defaultExport) as LoadedModule;
          } else if (
            defaultExport &&
            typeof defaultExport === "object" &&
            Object.getPrototypeOf(defaultExport)?.constructor?.name === "Promise"
          ) {
            resolved = await (defaultExport as Promise<LoadedModule>);
          }
          try {
            const ctor = responseCacheCtor();
            if (ctor) unlatchResponseCache(resolved, ctor);
            // The route's own pathname keys the _ENTRIES fallback — the registry is
            // process-global, so a pool with several edge routes must select by key.
            return resolveRouteHandlerExport(resolved, output.pathname);
          } catch (err) {
            throw new Error(
              `Failed to resolve handler for outputId="${outputId}" ` +
                `filePath="${output.filePath}": ${(err as Error).message}`,
            );
          }
        },
      );
      // Evict a rejected load from the cache so a later request can retry —
      // otherwise a transient import failure poisons the route for the pod's life.
      promise.catch(() => {
        if (cache.get(outputId) === promise) cache.delete(outputId);
      });
      cache.set(outputId, promise);
      return promise;
    },

    has(outputId: string): boolean {
      return !!manifest.outputs[outputId];
    },

    get(outputId: string) {
      return manifest.outputs[outputId];
    },
  };
}

export type HandlerLoader = ReturnType<typeof createHandlerLoader>;
