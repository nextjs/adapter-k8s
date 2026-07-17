// src/pool-server/handler-loader.ts
import { pathToFileURL } from "node:url";
import path from "node:path";
import type { PoolManifest } from "../types.js";

export type ArtifactRouteHandler = (...args: unknown[]) => unknown;
type LoadedModule = Record<string, unknown>;
type LoadModuleFn = (entrypointPath: string) => Promise<LoadedModule>;

// Same resolution order as AWS adapter: handler, default, default.handler, default.fetch, fetch
export function resolveRouteHandlerExport(module: LoadedModule): ArtifactRouteHandler {
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
  // Try to find a matching entry and extract its handler/default export.
  const entries = (globalThis as Record<string, unknown>)._ENTRIES as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (entries) {
    for (const entry of Object.values(entries)) {
      if (typeof entry?.default === "function") return entry.default as ArtifactRouteHandler;
      if (typeof entry?.handler === "function") return entry.handler as ArtifactRouteHandler;
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

// Feature-detect Next 16.3+'s WebSocket upgrade handler (see nextjs/adapter-vercel#86). Returns
// undefined (never throws) when the module exports none, so any Next version without the API — and
// every non-WebSocket route — degrades gracefully: the caller answers 426 instead of failing.
export function resolveUpgradeHandlerExport(
  module: LoadedModule,
): ArtifactRouteHandler | undefined {
  try {
    // 1. Top-level generated entrypoint — where Next's adapter output exposes it once
    //    `experimental.webSocketRouteHandlers` ships (RFC nextjs#95514). App Route modules wrap
    //    their surface in `default`, so check both.
    if (typeof module.upgradeHandler === "function") {
      return module.upgradeHandler as ArtifactRouteHandler;
    }
    const def = module.default as Record<string, unknown> | undefined;
    if (def && typeof def === "object" && typeof def.upgradeHandler === "function") {
      return def.upgradeHandler as ArtifactRouteHandler;
    }
    // 2. On the AppRouteRouteModule — directly, or in its userland exports (`routeModule.userland`),
    //    which is where a route's own `upgradeHandler` export lands. Present at the top level or
    //    under the default export depending on the Turbopack/webpack build.
    for (const candidate of [module.routeModule, def?.routeModule]) {
      if (!candidate || typeof candidate !== "object") continue;
      const rm = candidate as Record<string, unknown>;
      if (typeof rm.upgradeHandler === "function") {
        return rm.upgradeHandler as ArtifactRouteHandler;
      }
      const userland = rm.userland as Record<string, unknown> | undefined;
      if (userland && typeof userland.upgradeHandler === "function") {
        return userland.upgradeHandler as ArtifactRouteHandler;
      }
    }
  } catch {
    // A throwing `userland` getter (or any exotic module shape) must not fail the upgrade —
    // fall through to undefined so the caller answers 426.
  }
  return undefined;
}

export function createHandlerLoader(
  manifest: PoolManifest,
  loadModule: LoadModuleFn = (p) => import(pathToFileURL(path.resolve(process.cwd(), p)).href),
) {
  // Cache the loaded+unwrapped module (not just its HTTP handler) so both the request handler and
  // the optional WebSocket upgradeHandler are derived from a single import per output.
  const moduleCache = new Map<string, Promise<LoadedModule>>();

  function loadUnwrappedModule(outputId: string): Promise<LoadedModule> {
    const cached = moduleCache.get(outputId);
    if (cached) return cached;

    const output = manifest.outputs[outputId]!; // both callers verify existence first
    const promise = loadModule(output.filePath).then(async (module): Promise<LoadedModule> => {
      // Turbopack modules with top-level await (e.g., Genkit, heavy async deps) may export a
      // Promise as module.exports. Await it to get the real exports.
      const defaultExport = module.default;
      if (defaultExport instanceof Promise) {
        return (await defaultExport) as LoadedModule;
      }
      if (
        defaultExport &&
        typeof defaultExport === "object" &&
        Object.getPrototypeOf(defaultExport)?.constructor?.name === "Promise"
      ) {
        return (await (defaultExport as Promise<LoadedModule>)) as LoadedModule;
      }
      return module;
    });
    // Evict a rejected load from the cache so a later request can retry —
    // otherwise a transient import failure poisons the route for the pod's life.
    promise.catch(() => {
      if (moduleCache.get(outputId) === promise) moduleCache.delete(outputId);
    });
    moduleCache.set(outputId, promise);
    return promise;
  }

  return {
    async load(outputId: string): Promise<ArtifactRouteHandler> {
      const output = manifest.outputs[outputId];
      if (!output) {
        throw new Error(`Unknown output ID: ${outputId} for pool ${manifest.poolName}`);
      }
      const module = await loadUnwrappedModule(outputId);
      try {
        return resolveRouteHandlerExport(module);
      } catch (err) {
        throw new Error(
          `Failed to resolve handler for outputId="${outputId}" ` +
            `filePath="${output.filePath}": ${(err as Error).message}`,
        );
      }
    },

    // Optional WebSocket upgrade handler. undefined ⇒ no WebSocket support on this route
    // (older Next, or an ordinary route); the caller degrades gracefully with a 426.
    async loadUpgrade(outputId: string): Promise<ArtifactRouteHandler | undefined> {
      if (!manifest.outputs[outputId]) return undefined;
      const module = await loadUnwrappedModule(outputId);
      return resolveUpgradeHandlerExport(module);
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
