// tests/emit/internal-secret-build-scope.test.ts
//
// N87 (SECURITY, phase-7 skew design). The restarted-old-pod case.
//
// The internal dispatch secret is derived per BUILD, but the Secret used to be STABLE-NAMED
// (`<release>-internal-header-secret`) and `helm upgrade` overwrites it BEFORE pool cutover.
// It reaches pods via `secretKeyRef`, so the value resolves at CONTAINER START:
//
//   * a WARM build-A pod keeps A's value, rejects B's dispatch headers and re-resolves
//     locally (fail-safe, at the cost of running middleware twice);
//   * a build-A pod that RESTARTS inside the deploy window read the NEW Secret and therefore
//     TRUSTED build B's `x-mw-evaluated` verdict — it could skip A's middleware and serve A's
//     routes under B's middleware decisions (invariant 2: middleware is never bypassed).
//
// This suite drives the real chart renderer through an A→B deploy against a fake cluster that
// reproduces helm's prune-on-upgrade semantics, then feeds the value a restarted A pod would
// resolve into the REAL pool-server trust boundary. The assertion is the security property
// itself: a pod resolving build A's secret must not trust a verdict stamped under B's.
import { describe, it, expect } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { generateHelmChart } from "../../src/emit/helm.js";
import {
  internalSecretName,
  legacyInternalSecretName,
  renderInternalSecretEnv,
  INTERNAL_SECRET_KEY,
} from "../../src/emit/templates/internal-secret.js";
import { applyRequestTrustBoundary } from "../../src/pool-server/server.js";
import { INTERNAL_SECRET_HEADER } from "../../src/routing-common.js";
import type { PoolDefinition, K8sAdapterConfig, RoutingManifest } from "../../src/types.js";

const RELEASE = "nextjs";

const manifestFor = (buildId: string): RoutingManifest =>
  ({
    routeGraph: { rsc: {} } as any,
    pathnames: [],
    i18n: null,
    buildId,
    builtAt: "2026-01-01T00:00:00.000Z",
    basePath: "",
    middleware: null,
    poolAssignments: {},
    pprRoutes: {},
    pprCapableRoutes: {},
  }) as unknown as RoutingManifest;

const MINIMAL_CHAIN_JSON = JSON.stringify([
  {
    name: "nextjs-routing",
    matchCondition: { celExpression: "true" },
    extensions: [
      {
        name: "routing-service",
        authority: "nextjs-routing-service.default.svc.cluster.local",
        service: "projects/p-123456/global/backendServices/nextjs-routing-service",
        timeout: "5s",
        supportedEvents: ["REQUEST_HEADERS"],
        failOpen: false,
      },
    ],
  },
]);

const config = {
  pools: { ssr: { routes: ["appPages"] } },
  provider: {
    gke: { gateway: { type: "gateway-api", hosts: [{ hostname: "app.example.com" }] } },
  },
} as K8sAdapterConfig;

function renderChart(buildId: string, secret: string): Record<string, string> {
  const pools = new Map<string, PoolDefinition>([
    ["ssr", { name: "ssr", outputs: [], config: { routes: ["appPages"] } }],
  ]);
  return generateHelmChart({
    pools,
    buildId,
    nextVersion: "16.2.0",
    config,
    imageRegistry: "gcr.io/my-project",
    routingManifest: manifestFor(buildId),
    extensionChainJson: MINIMAL_CHAIN_JSON,
    infrastructure: { projectId: "my-project", region: "us-central1" },
    internalSecret: secret,
  });
}

/** The Secret name a rendered manifest's first `secretKeyRef` for INTERNAL_HEADER_SECRET names. */
function secretRefIn(manifest: string): string {
  const m =
    /- name: INTERNAL_HEADER_SECRET\s*\n\s*valueFrom:\s*\n\s*secretKeyRef:\s*\n\s*name: (\S+)\s*\n\s*key: (\S+)/.exec(
      manifest,
    );
  if (!m) throw new Error("no INTERNAL_HEADER_SECRET secretKeyRef in the rendered manifest");
  expect(m[2]).toBe(INTERNAL_SECRET_KEY);
  return m[1]!;
}

/** `metadata.name` and `stringData.secret` of a rendered Secret template. */
function parseSecret(manifest: string): { name: string; value: string; keep: boolean } {
  const name = /^  name: (\S+)$/m.exec(manifest)?.[1];
  const value = /^  secret: "(.*)"$/m.exec(manifest)?.[1];
  if (!name || value === undefined) throw new Error("unparseable Secret template");
  return { name, value, keep: /helm\.sh\/resource-policy: keep/.test(manifest) };
}

/**
 * A cluster that reproduces the ONE helm behavior this fix depends on: on `helm upgrade`,
 * resources in the previous release manifest but not the new one are DELETED, unless the live
 * object carries `helm.sh/resource-policy: keep` (helm reads the annotation off the live
 * object — kube/client.go `Update`, which is also why deploy can annotate the legacy Secret
 * imperatively and have it respected).
 */
class FakeCluster {
  secrets = new Map<string, { value: string; keep: boolean }>();
  private applied = new Set<string>();

  helmUpgrade(chart: Record<string, string>) {
    const secret = parseSecret(chart["templates/internal-secret.yaml"]!);
    const next = new Set([secret.name]);
    for (const name of this.applied) {
      if (next.has(name)) continue;
      if (this.secrets.get(name)?.keep) continue; // helm skips deletion
      this.secrets.delete(name);
    }
    this.secrets.set(secret.name, { value: secret.value, keep: secret.keep });
    this.applied = next;
  }

  /** What kubelet resolves into a container's env when the pod (re)starts. */
  resolve(secretName: string): string | undefined {
    return this.secrets.get(secretName)?.value;
  }

  /** The pre-N87 shape: one stable-named Secret, overwritten by every upgrade. */
  legacyUpgrade(value: string) {
    const name = legacyInternalSecretName(RELEASE);
    this.secrets.set(name, { value, keep: false });
    this.applied = new Set([name]);
  }
}

/** A minimal req/res pair for the real trust boundary. */
function fakeReqRes(headers: Record<string, string>) {
  const req = { headers: { ...headers } } as unknown as IncomingMessage;
  const res = {
    getHeaderNames: () => [] as string[],
    removeHeader: () => {},
    writeHead() {
      return this;
    },
    on: () => {},
  } as unknown as ServerResponse;
  return { req, res };
}

/**
 * Does a pool pod holding `podSecret` act on a dispatch verdict signed with `presented`?
 * Runs the REAL boundary (pool-server/server.ts), so this is the production decision, not a
 * restatement of it.
 */
function trustsVerdict(podSecret: string | undefined, presented: string): boolean {
  const { req, res } = fakeReqRes({
    [INTERNAL_SECRET_HEADER]: presented,
    "x-mw-evaluated": "1",
    "x-output-id": "/dashboard",
  });
  applyRequestTrustBoundary(req, res, { internalSecret: podSecret, trustInternalHeaders: false });
  // The secret itself must never survive the boundary either way.
  expect(req.headers[INTERNAL_SECRET_HEADER]).toBeUndefined();
  return req.headers["x-mw-evaluated"] !== undefined;
}

describe("N87: a restarted build-A pod cannot trust build B's middleware verdict", () => {
  const A = { buildId: "build-a", secret: "a".repeat(64) };
  const B = { buildId: "build-b", secret: "b".repeat(64) };

  it("resolves A's secret after B's helm upgrade, so B's verdict is not trusted", () => {
    const chartA = renderChart(A.buildId, A.secret);
    const chartB = renderChart(B.buildId, B.secret);

    // The name build A's pod template will ask kubelet for, for the whole life of that pod
    // template — including every restart, whichever build is being deployed at the time.
    const podARef = secretRefIn(chartA["templates/ssr-deployment.yaml"]!);
    const podBRef = secretRefIn(chartB["templates/ssr-deployment.yaml"]!);
    expect(podARef).not.toBe(podBRef);

    const cluster = new FakeCluster();
    cluster.helmUpgrade(chartA); // deploy A
    cluster.helmUpgrade(chartB); // deploy B — runs BEFORE pool cutover (deploy.ts step 6)

    // A's Secret survived the upgrade (resource-policy: keep) with A's value intact...
    expect(cluster.resolve(podARef)).toBe(A.secret);
    // ...and B's exists alongside it, so the two tiers of build B agree on their own value.
    expect(cluster.resolve(podBRef)).toBe(B.secret);
    expect(secretRefIn(chartB["templates/routing-service-deployment.yaml"]!)).toBe(podBRef);

    // THE RESTART: a build-A pod is evicted/OOM-killed/scaled up mid-window and starts fresh,
    // resolving its secretKeyRef against the cluster as it is NOW.
    const restartedPodASecret = cluster.resolve(podARef);
    expect(restartedPodASecret).toBe(A.secret);

    // Build B's routing service dispatches to it (the active Service still selects A until
    // cutover). Its verdict must NOT be trusted: the pod re-resolves locally, so A's
    // middleware runs (invariant 2).
    expect(trustsVerdict(restartedPodASecret, B.secret)).toBe(false);
    // Control: the same pod DOES trust its own build's dispatch, so the assertion above is
    // about the build scope and not about the boundary rejecting everything.
    expect(trustsVerdict(restartedPodASecret, A.secret)).toBe(true);
  });

  it("is what the pre-N87 stable-named Secret got wrong (the bug this replaces)", () => {
    // Same sequence with the OLD shape: one stable name, overwritten in place. The restarted
    // A pod resolves B's value and therefore trusts B's verdict — A's routes served under B's
    // middleware decisions. Kept as an executable statement of the failure, so the property
    // above cannot be "fixed" back into this.
    const cluster = new FakeCluster();
    cluster.legacyUpgrade(A.secret);
    cluster.legacyUpgrade(B.secret);
    const restarted = cluster.resolve(legacyInternalSecretName(RELEASE));
    expect(restarted).toBe(B.secret);
    expect(trustsVerdict(restarted, B.secret)).toBe(true);

    // Under the per-build scheme the same pod template resolves nothing but its own build.
    const chartA = renderChart(A.buildId, A.secret);
    expect(secretRefIn(chartA["templates/ssr-deployment.yaml"]!)).not.toBe(
      legacyInternalSecretName(RELEASE),
    );
  });

  it("never gives two build ids the same Secret name, even past the 63-char truncation", () => {
    // The digest suffix is reserved INSIDE the DNS cap (same scheme as
    // routingManifestSnapshotName), so truncation can eat the readable build id but never the
    // digest. A collision here would put two builds back on one mutable value — the exact
    // condition this fix removes.
    const longRelease = "a".repeat(40);
    const names = new Set<string>();
    const buildIds = [
      "2026.07.26.1",
      "2026.07.26.2",
      "v1.0.0-canary.1",
      "v1.0.0-canary.2",
      "b".repeat(120) + "1",
      "b".repeat(120) + "2",
    ];
    for (const buildId of buildIds) {
      for (const release of [RELEASE, longRelease]) {
        const name = internalSecretName(release, buildId);
        expect(name.length).toBeLessThanOrEqual(63);
        expect(name).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
        expect(names.has(name)).toBe(false);
        names.add(name);
      }
    }
  });

  it("mirrors a legacy Secret name when the retained render passes one, and validates it", () => {
    // The literal override exists for exactly one caller: deploy's retained previous-build
    // render, mirroring a live pod template that predates per-build names (see
    // renderInternalSecretEnv). It is cluster-sourced, so the charset is enforced here.
    const legacy = legacyInternalSecretName(RELEASE);
    expect(renderInternalSecretEnv(RELEASE, A.buildId, "  ", legacy)).toContain(`name: ${legacy}`);
    expect(renderInternalSecretEnv(RELEASE, A.buildId, "  ")).toContain(
      `name: ${internalSecretName(RELEASE, A.buildId)}`,
    );
    for (const bad of [
      'x"\n  hostNetwork: true',
      "-leading",
      "trailing-",
      "Upper",
      "a".repeat(254),
    ]) {
      expect(() => renderInternalSecretEnv(RELEASE, A.buildId, "  ", bad)).toThrow(
        /Invalid Secret name/,
      );
    }
  });

  it("is stable across re-renders of the same build (invariant 5)", () => {
    const first = renderChart(A.buildId, A.secret);
    const second = renderChart(A.buildId, A.secret);
    expect(second["templates/internal-secret.yaml"]).toBe(first["templates/internal-secret.yaml"]);
    expect(second["templates/ssr-deployment.yaml"]).toBe(first["templates/ssr-deployment.yaml"]);
  });
});
