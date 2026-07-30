// The CEL match condition is EXCLUSION-ONLY: ext_proc runs unless a path can be proven not to
// need it. This file pins the two properties that follow from that choice.
//
// Measured on GKE 2026-07-29 deploying upstream's app-dir/app-static:
//   INVALID_CEL_EXPRESSION: expression exceeded max length 512
// The old no-middleware branch ENUMERATED the paths that needed ext_proc — one exact match per
// prerender output, and each App Router route emits ~9 of them (`.rsc`, `.segments/_tree|_full|
// _index|_head`, per-segment). ~20 routes produced ~30KB against a 512-char ceiling.
//
// The fix is not a smaller enumeration, it is the opposite polarity. The match condition exists
// to get middleware and PPR requests to the routing service, so the only unacceptable failure is
// UNDER-matching — a PPR route that misses the callout loses edge behaviour silently. An
// exclusion list fails the safe way (a forgotten exclusion costs one callout). Public-file
// exclusions were then dropped too — stable URLs stay CDN-cached across deploys, so they
// optimized the case the CDN already handles — leaving exactly one exclusion and an expression
// that cannot grow at all.
import { describe, it, expect } from "vitest";
import { generateCelExpression, CEL_EXPRESSION_WARN_LENGTH } from "../src/cel.js";
import { mockOutputs, mockPrerender } from "./helpers/mock-outputs.js";

/**
 * Evaluate the subset of CEL this module emits, so coverage can be asserted as a property
 * rather than by matching on the generated string. Supports `true`/`false`,
 * `request.path == 'x'`, `request.path.startsWith('x')`, ` || `, and a leading `!( ... )`.
 */
function celMatches(expr: string, path: string): boolean {
  if (expr === "true") return true;
  if (expr === "false") return false;
  let negated = false;
  let body = expr;
  if (body.startsWith("!(") && body.endsWith(")")) {
    negated = true;
    body = body.slice(2, -1);
  }
  const any = body.split(" || ").some((t) => {
    let m = /^request\.path == '(.*)'$/.exec(t);
    if (m) return path === m[1];
    m = /^request\.path\.startsWith\('(.*)'\)$/.exec(t);
    if (m) return path.startsWith(m[1]!);
    throw new Error(`unsupported CEL term: ${t}`);
  });
  return negated ? !any : any;
}

/** The `.rsc` / `.segments/*` family a single App Router route emits, as seen in app-static. */
function routeVariants(base: string): string[] {
  return [
    base,
    `${base}.rsc`,
    `${base}.segments/_tree.segment.rsc`,
    `${base}.segments/_full.segment.rsc`,
    `${base}.segments/_index.segment.rsc`,
    `${base}.segments/_head.segment.rsc`,
    `${base}.segments${base}/__PAGE__.segment.rsc`,
  ];
}

const isrOutputs = (paths: string[]) =>
  mockOutputs({
    prerenders: paths.map((p) =>
      mockPrerender({ pathname: p, fallback: { initialRevalidate: 60 } as any }),
    ),
  });

describe("CEL is a constant, so it cannot grow or mis-exclude", () => {
  it("stays the same size for 20 routes as for 1 — the app-static failure mode is gone", () => {
    const one = generateCelExpression({
      outputs: isrOutputs(routeVariants("/blog/a")),
      dynamicRoutes: [],
    });
    const many = generateCelExpression({
      outputs: isrOutputs(
        Array.from({ length: 20 }, (_, i) => `/variable-revalidate/route-${i}`).flatMap(
          routeVariants,
        ),
      ),
      dynamicRoutes: [],
    });

    expect(many).toBe(one);
    expect(many.length).toBeLessThanOrEqual(CEL_EXPRESSION_WARN_LENGTH);
  });

  it("covers every prerendered route and its .rsc/.segments representations", () => {
    // The property that matters: no PPR/ISR path may miss the callout.
    const paths = ["/blog/a", "/articles/works", "/deeply/nested/x"].flatMap(routeVariants);
    const cel = generateCelExpression({ outputs: isrOutputs(paths), dynamicRoutes: [] });

    for (const p of paths) expect(celMatches(cel, p)).toBe(true);
    expect(celMatches(cel, "/_next/image?url=%2Ff.png&w=64")).toBe(true);
  });

  it("emits `false` when nothing could possibly need the callout", () => {
    // No middleware, no prerendered output, no dynamic routes — the routing service would have
    // nothing to do, so skip the callout entirely rather than pay for a no-op.
    expect(generateCelExpression({ outputs: mockOutputs({}), dynamicRoutes: [] })).toBe("false");
  });

  it("keeps the extension for a prerendered app even with no middleware", () => {
    // Conservative on purpose: PPR routes are not separately identifiable here, and losing PPR
    // at the edge is the failure this match condition exists to prevent.
    const cel = generateCelExpression({
      outputs: isrOutputs(["/blog/a"]),
      dynamicRoutes: [],
    });
    expect(cel).not.toBe("false");
  });
});
