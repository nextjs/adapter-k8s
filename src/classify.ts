// src/classify.ts
import { minimatch } from "minimatch";
import type { AdapterOutput, AdapterOutputs, K8sAdapterConfig, PoolDefinition } from "./types.js";

type FunctionOutput =
  | AdapterOutput["APP_PAGE"]
  | AdapterOutput["APP_ROUTE"]
  | AdapterOutput["PAGES"]
  | AdapterOutput["PAGES_API"];

const OUTPUT_TYPE_KEYS: Record<
  string,
  keyof Pick<AdapterOutputs, "appPages" | "appRoutes" | "pages" | "pagesApi">
> = {
  appPages: "appPages",
  appRoutes: "appRoutes",
  pages: "pages",
  pagesApi: "pagesApi",
};

export function classifyIntoPools(
  outputs: AdapterOutputs,
  config: K8sAdapterConfig,
): Map<string, PoolDefinition> {
  const pools = new Map<string, PoolDefinition>();
  const assigned = new Set<string>();

  for (const [poolName, poolConfig] of Object.entries(config.pools)) {
    const matched: FunctionOutput[] = [];

    for (const routeSpec of poolConfig.routes) {
      let candidates: FunctionOutput[];

      const typeKey = OUTPUT_TYPE_KEYS[routeSpec];
      if (typeKey) {
        candidates = outputs[typeKey] as FunctionOutput[];
      } else {
        candidates = [
          ...outputs.appPages,
          ...outputs.appRoutes,
          ...outputs.pages,
          ...outputs.pagesApi,
        ].filter((o) => minimatch(o.pathname, routeSpec));
      }

      for (const output of candidates) {
        if (!assigned.has(output.id)) {
          assigned.add(output.id);
          matched.push(output);
        }
      }
    }

    pools.set(poolName, {
      name: poolName,
      outputs: matched,
      config: poolConfig,
    });
  }

  // Find unassigned outputs
  const allFunctionalOutputs = [
    ...outputs.appPages,
    ...outputs.appRoutes,
    ...outputs.pages,
    ...outputs.pagesApi,
  ];

  for (const output of allFunctionalOutputs) {
    if (!assigned.has(output.id)) {
      throw new Error(
        `Output "${output.id}" is not assigned to any pool. Check your adapter config.`
      );
    }
  }

  return pools;
}
