// src/types.ts
import type { NextAdapter, AdapterOutput } from "next";
import type { ResolveRoutesParams } from "@next/routing";

// Define AdapterOutputs locally since it's not exported from "next"
export interface AdapterOutputs {
  appPages: Array<AdapterOutput["APP_PAGE"]>;
  appRoutes: Array<AdapterOutput["APP_ROUTE"]>;
  pages: Array<AdapterOutput["PAGES"]>;
  pagesApi: Array<AdapterOutput["PAGES_API"]>;
  prerenders: Array<AdapterOutput["PRERENDER"]>;
  staticFiles: Array<AdapterOutput["STATIC_FILE"]>;
  middleware?: AdapterOutput["MIDDLEWARE"] | null;
}

// Re-export Next.js types we use throughout
export type { NextAdapter, AdapterOutput };
export type BuildCompleteContext = Parameters<NonNullable<NextAdapter["onBuildComplete"]>>[0];

// --- Adapter Config ---

export interface PoolConfig {
  routes: string[]; // OutputType name ('appPages', 'appRoutes', 'pages', 'pagesApi') or glob pattern
  scaling?: { min: number; max: number; targetCPU: number };
  resources?: { cpu: string; memory: string };
  timeout?: number;
}

export interface HostConfig {
  hostname: string;
  tls: {
    enabled: boolean;
    managedCert?: boolean;
  };
}

export interface GKEProviderConfig {
  cdn?: { enabled: boolean; bucket: string; origin?: string };
  gateway?: {
    type: "gateway-api" | "ingress";
    className: string;
    hosts: HostConfig[];
  };
  serviceExtensions?: {
    routeExtension?: { timeout?: number };
  };
}

export interface K8sAdapterConfig {
  pools: Record<string, PoolConfig>;
  cache?: { enabled: boolean; provider: "valkey" | "redis" };
  containerStrategy?: "traced-assets" | "shared-image";
  imageOptimizer?: { enabled: boolean; mode: "sidecar" };
  skewProtection?: { enabled: boolean; duration: string };
  routeExtension?: { mode: "auto" | "wasm" | "extproc" };
  provider: { gke: GKEProviderConfig };
}

// --- Internal Types ---

export interface PoolDefinition {
  name: string;
  outputs: Array<
    | AdapterOutput["APP_PAGE"]
    | AdapterOutput["APP_ROUTE"]
    | AdapterOutput["PAGES"]
    | AdapterOutput["PAGES_API"]
  >;
  config: PoolConfig;
}

// The route graph shape passed to resolveRoutes — matches ctx.routing from onBuildComplete
export type RouteGraph = ResolveRoutesParams["routes"] & {
  shouldNormalizeNextData: boolean;
  rsc: BuildCompleteContext["routing"]["rsc"];
};

export interface RoutingManifest {
  routeGraph: RouteGraph;
  pathnames: string[];
  i18n: BuildCompleteContext["config"]["i18n"] | null;
  buildId: string;
  basePath: string;
  middleware: { filePath: string } | null;
  poolAssignments: Record<string, string>;
  pprRoutes: Record<
    string,
    {
      postponedState: string;
      fallbackFilePath: string;
    }
  >;
  nextVersion: string;
}

export interface PoolManifest {
  buildId: string;
  poolName: string;
  outputs: Record<
    string,
    {
      id: string;
      filePath: string;
      pathname: string;
      type: string;
    }
  >;
}

export interface StaticAssetEntry {
  pathname: string;
  filePath: string;
  cacheControl: string;
}
