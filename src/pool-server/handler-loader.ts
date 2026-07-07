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
    const dt = dk.map((k) => `${k}:${typeof (module.default as Record<string, unknown>)[k]}`).join(", ");
    defaultInfo = ` default={${dt}}`;
  }
  throw new Error(
    `Could not find a valid handler export (handler, default, fetch) in the module. ` +
    `Exports: [${exportTypes}]${defaultInfo}`
  );
}

export function createHandlerLoader(
  manifest: PoolManifest,
  loadModule: LoadModuleFn = (p) => import(pathToFileURL(path.resolve(process.cwd(), p)).href),
) {
  const cache = new Map<string, Promise<ArtifactRouteHandler>>();

  return {
    async load(outputId: string): Promise<ArtifactRouteHandler> {
      const cached = cache.get(outputId);
      if (cached) return cached;

      const output = manifest.outputs[outputId];
      if (!output) {
        throw new Error(`Unknown output ID: ${outputId} for pool ${manifest.poolName}`);
      }

      const promise = loadModule(output.filePath).then(async (module): Promise<ArtifactRouteHandler> => {
        // Turbopack modules with top-level await (e.g., Genkit, heavy async deps)
        // may export a Promise as module.exports. Await it to get the real exports.
        let resolved: LoadedModule = module;
        const defaultExport = module.default;
        if (defaultExport instanceof Promise) {
          resolved = (await defaultExport) as LoadedModule;
        } else if (defaultExport && typeof defaultExport === "object" && Object.getPrototypeOf(defaultExport)?.constructor?.name === "Promise") {
          resolved = (await (defaultExport as Promise<LoadedModule>));
        }
        try {
          return resolveRouteHandlerExport(resolved);
        } catch (err) {
          throw new Error(
            `Failed to resolve handler for outputId="${outputId}" ` +
            `filePath="${output.filePath}": ${(err as Error).message}`
          );
        }
      });
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
