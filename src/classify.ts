// src/classify.ts
import { escape, minimatch } from "minimatch";
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

// Pool selectors are globs over the route template pathnames emitted by Next, not over
// concrete request URLs. A full segment such as `[slug]` therefore names that literal route
// template. Passing it straight to minimatch instead treats the brackets as a character class:
// `/blog/[slug]` misses the dynamic output and can claim an unrelated `/blog/s` route instead.
// Interception markers are glued to the segment they target (`(.)[user]`,
// `(..)(..)[...slug]`) and remain present in Next's output pathname. Treat that whole form as
// literal too; otherwise the dynamic tail is still a minimatch character class and can claim a
// static interception output such as `(.)u`. Ordinary glob syntax such as `v[12]`, `*`, `**`,
// braces, and extglobs keeps its minimatch meaning outside these Next-specific segment forms.
const NEXT_DYNAMIC_SEGMENT = /^(?:\(\.{1,3}\))*(?:\[(?:\.\.\.)?[^/[\]]+\]|\[\[\.\.\.[^/[\]]+\]\])$/;

function normalizeRouteSelector(selector: string): string {
  return selector
    .split("/")
    .map((segment) => (NEXT_DYNAMIC_SEGMENT.test(segment) ? escape(segment) : segment))
    .join("/");
}

export function classifyIntoPools(
  outputs: AdapterOutputs,
  config: K8sAdapterConfig,
): Map<string, PoolDefinition> {
  const pools = new Map<string, PoolDefinition>();
  const assigned = new Set<string>();

  for (const [poolName, poolConfig] of Object.entries(config.pools)) {
    const matched: FunctionOutput[] = [];
    const specsWithCandidates = new Set<string>();

    for (const routeSpec of poolConfig.routes) {
      let candidates: FunctionOutput[];

      const typeKey = OUTPUT_TYPE_KEYS[routeSpec];
      if (typeKey) {
        candidates = outputs[typeKey] as FunctionOutput[];
      } else {
        const selector = normalizeRouteSelector(routeSpec);
        candidates = [
          ...outputs.appPages,
          ...outputs.appRoutes,
          ...outputs.pages,
          ...outputs.pagesApi,
        ].filter((o) => minimatch(o.pathname, selector));
      }

      if (candidates.length > 0) specsWithCandidates.add(routeSpec);

      for (const output of candidates) {
        if (!assigned.has(output.id)) {
          assigned.add(output.id);
          matched.push(output);
        }
      }
    }

    // A zero-output pool still gets a Deployment/HPA/Service and a share of the
    // HTTPRoute rule budget — deployed empty, it serves nothing and silently
    // drains the 16-rule cap. Almost always a typo'd route pattern, so say which
    // patterns matched nothing (vs. claimed by an earlier pool, first-match-wins).
    if (matched.length === 0) {
      const unmatched = poolConfig.routes.filter((spec) => !specsWithCandidates.has(spec));
      console.warn(
        `[adapter-k8s] Pool "${poolName}" matched no outputs and will be deployed empty. ` +
          (unmatched.length > 0
            ? `Route patterns that matched no output: ${unmatched
                .map((s) => JSON.stringify(s))
                .join(", ")}. `
            : `Every route pattern matched only outputs already claimed by earlier pools ` +
              `(first-match-wins). `) +
          `Check the pools."${poolName}".routes entries in your adapter config.`,
      );
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
        `Output "${output.id}" is not assigned to any pool. Check your adapter config.`,
      );
    }
  }

  return pools;
}
