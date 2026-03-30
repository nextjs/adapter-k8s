// src/pool-server/handler-loader.ts
import { pathToFileURL } from "node:url";
import path from "node:path";
import type { PoolManifest } from "../types.js";

export type ArtifactRouteHandler = (...args: unknown[]) => unknown;
type LoadedModule = Record<string, unknown>;
type LoadModuleFn = (entrypointPath: string) => Promise<LoadedModule>;

// Same resolution order as AWS adapter: handler, default, default.handler, default.fetch, fetch
export function resolveRouteHandlerExport(
  module: LoadedModule,
): ArtifactRouteHandler {
  if (typeof module.handler === "function")
    return module.handler as ArtifactRouteHandler;
  if (typeof module.default === "function")
    return module.default as ArtifactRouteHandler;
  if (module.default && typeof module.default === "object") {
    const nested = module.default as Record<string, unknown>;
    if (typeof nested.handler === "function")
      return nested.handler as ArtifactRouteHandler;
    if (typeof nested.fetch === "function")
      return nested.fetch as ArtifactRouteHandler;
  }
  if (typeof module.fetch === "function")
    return module.fetch as ArtifactRouteHandler;

  throw new Error(
    "Could not find a valid handler export (handler, default, fetch) in the module.",
  );
}

export function createHandlerLoader(
  manifest: PoolManifest,
  loadModule: LoadModuleFn = (p) =>
    import(pathToFileURL(path.resolve(process.cwd(), p)).href),
) {
  const cache = new Map<string, Promise<ArtifactRouteHandler>>();

  return {
    async load(outputId: string): Promise<ArtifactRouteHandler> {
      const cached = cache.get(outputId);
      if (cached) return cached;

      const output = manifest.outputs[outputId];
      if (!output) {
        throw new Error(
          `Unknown output ID: ${outputId} for pool ${manifest.poolName}`,
        );
      }

      const promise = loadModule(output.filePath).then((module) =>
        resolveRouteHandlerExport(module),
      );
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
