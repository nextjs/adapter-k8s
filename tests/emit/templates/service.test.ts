import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  renderActiveService,
  renderOriginService,
  renderService,
} from "../../../src/emit/templates/service.js";
import {
  findBuildIdNameCollision,
  findEmittedNameCollision,
  sanitizeK8sName,
} from "../../../src/emit/templates/utils.js";

function helmVersion(): string | null {
  try {
    return execFileSync("helm", ["version", "--short"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** Render a set of template files with real helm and return the output (or the error text). */
function helmRender(files: Record<string, string>, sets: string[] = []) {
  const dir = mkdtempSync(path.join(tmpdir(), "svc-helm-"));
  try {
    mkdirSync(path.join(dir, "templates"));
    writeFileSync(path.join(dir, "Chart.yaml"), "apiVersion: v2\nname: s\nversion: 0.0.0\n");
    writeFileSync(path.join(dir, "values.yaml"), "activeBuildId: someBuild\n");
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(path.join(dir, name), content);
    }
    const args = ["template", "s", dir, ...sets.flatMap((s) => ["--set", s])];
    try {
      return { ok: true, out: execFileSync("helm", args, { encoding: "utf8", stdio: "pipe" }) };
    } catch (err) {
      const e = err as { stderr?: Buffer | string; message?: string };
      return { ok: false, out: String(e.stderr ?? e.message ?? "") };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("renderService (versioned)", () => {
  it("N61: quotes the pool name in the label block AND the selector", () => {
    const yaml = renderService({ poolName: "on", buildId: "b1", releaseName: "my-app" });
    const lines = yaml.match(/^\s*app\.kubernetes\.io\/component: .*$/gm) ?? [];
    expect(lines).toHaveLength(2); // labels + selector
    for (const line of lines) expect(line).toMatch(/component: "on"$/);
    expect(yaml).not.toMatch(/component: (on|off|no|yes|y|n|true|false|[0-9]+)\s*$/m);
  });

  it("N75: emits NO HealthCheckPolicy — a versioned Service has no backend service to attach to", () => {
    const yaml = renderService({ poolName: "ssr", buildId: "b1", releaseName: "my-app" });
    // Nothing routes to the versioned Service (every HTTPRoute backendRef points at the
    // stable active Service), so the policy could never attach while still reporting an
    // `Attached` condition — two permanently-orphaned policies per build per pool.
    expect(yaml).not.toContain("kind: HealthCheckPolicy");
    expect(yaml.split("---")).toHaveLength(1);
    expect(yaml).toContain("kind: Service");
  });

  it("sanitizes releaseName / poolName / buildId at the consumption point", () => {
    expect(() => renderService({ poolName: "ssr", buildId: "b1", releaseName: "BAD" })).toThrow(
      /Invalid releaseName/,
    );
    expect(() => renderService({ poolName: "-x", buildId: "b1", releaseName: "my-app" })).toThrow(
      /Invalid pool name/,
    );
    expect(() =>
      renderService({ poolName: "ssr", buildId: 'a"\nx: y', releaseName: "my-app" }),
    ).toThrow(/Invalid buildId/);
  });
});

describe("renderOriginService (portable entrypoint)", () => {
  it("selects the active default-pool pods through one stable Service", () => {
    const yaml = renderOriginService({ poolName: "default", releaseName: "my-app" });
    expect(yaml).toContain("name: my-app-origin");
    expect(yaml).toContain('app.kubernetes.io/component: "default"');
    expect(yaml).toContain('app.kubernetes.io/version: "{{ .Values.activeBuildId }}"');
    expect(yaml).toContain("port: 3000");
    expect(yaml).not.toContain("kind: Deployment");
    expect(yaml).not.toContain("kind: HorizontalPodAutoscaler");
  });

  it("validates release and pool names at the template boundary", () => {
    expect(() => renderOriginService({ poolName: "default", releaseName: "BAD" })).toThrow(
      /Invalid releaseName/,
    );
    expect(() => renderOriginService({ poolName: "-bad", releaseName: "my-app" })).toThrow(
      /Invalid pool name/,
    );
  });

  it("attaches the GKE health check to the origin backend when requested", () => {
    const yaml = renderOriginService({
      poolName: "default",
      releaseName: "my-app",
      emitHealthCheckPolicy: true,
    });
    expect(yaml).toContain("kind: HealthCheckPolicy");
    expect(yaml).toContain("name: my-app-origin-hcp");
    expect(yaml).toContain("name: my-app-origin");
    expect(yaml).toContain("requestPath: {{ .Values.poolHealthCheckPath }}");
  });
});

describe("renderActiveService (stable)", () => {
  it("keeps the cutover-patched selector on activeBuildId", () => {
    const yaml = renderActiveService({ poolName: "ssr", releaseName: "my-app" });
    expect(yaml).toContain('app.kubernetes.io/version: "{{ .Values.activeBuildId }}"');
    expect(yaml).toContain("app.kubernetes.io/managed-by: adapter-k8s-active");
    for (const document of yaml.split("---")) {
      expect(document).toContain('helm.sh/resource-policy: ""');
    }
  });

  it("carries the stable HealthCheckPolicy, probing READINESS not liveness (N32)", () => {
    const yaml = renderActiveService({ poolName: "ssr", releaseName: "my-app" });
    expect(yaml).toContain("kind: HealthCheckPolicy");
    expect(yaml).toContain("name: my-app-ssr-hcp");
    const hcpDoc = yaml.split("---").find((d) => d.includes("HealthCheckPolicy"))!;
    expect(hcpDoc).toContain('app.kubernetes.io/name: "my-app"');
    expect(hcpDoc).toContain('app.kubernetes.io/component: "ssr"');
    // N32: this policy is the load balancer's OWN verdict — the last /healthz gate in the
    // cutover path. /healthz is a hardcoded 200 emitted before any routing/handler/manifest
    // work, so it cannot fail; /readyz 503s until the pod can actually serve.
    // Values-driven since the first-upgrade fix: this policy is helm-owned, so a helm upgrade
    // changes it BEFORE the cutover while the ACTIVE pods are still the previous build's — and
    // a build from an adapter that predates /readyz answers only /healthz, so a hardcoded
    // /readyz could mark every serving endpoint unhealthy mid-rollout. `deploy` sets the knob
    // to the liveness path for exactly one cycle in that case; values.yaml defaults to
    // readiness, which is what a fresh install and every subsequent deploy get.
    expect(yaml).toContain("requestPath: {{ .Values.poolHealthCheckPath }}");
    expect(yaml).not.toContain("requestPath: /healthz");
  });

  it("N65: emits a per-pool PodDisruptionBudget selecting on name+component (no version)", () => {
    const yaml = renderActiveService({ poolName: "ssr", releaseName: "my-app" });
    expect(yaml).toContain("apiVersion: policy/v1");
    expect(yaml).toContain("kind: PodDisruptionBudget");
    expect(yaml).toContain("name: my-app-ssr-pdb");
    expect(yaml).toContain("minAvailable: 1");
    // No `version` in the PDB selector: through a cutover BOTH builds' pods exist, and a
    // per-build PDB would leave the incoming build unguarded until the flip.
    const pdbDoc = yaml.split("---").find((d) => d.includes("PodDisruptionBudget"))!;
    expect(pdbDoc).not.toContain("app.kubernetes.io/version");
    expect(pdbDoc).toContain('app.kubernetes.io/component: "ssr"');
  });

  it("N65: the PDB lives here (rendered once per pool), never in the per-build templates", () => {
    // deploy.ts retains the previous versioned Service during cutover. A PDB there would
    // either duplicate a resource name or
    // need per-build cleanup; renderActiveService is emitted exactly once per pool.
    const versioned = renderService({ poolName: "ssr", buildId: "b1", releaseName: "my-app" });
    expect(versioned).not.toContain("PodDisruptionBudget");
  });

  it("N61: quotes the pool name in labels and both selectors", () => {
    const yaml = renderActiveService({ poolName: "no", releaseName: "my-app" });
    expect(yaml).not.toMatch(/component: (on|off|no|yes|y|n|true|false|[0-9]+)\s*$/m);
    expect((yaml.match(/component: "no"/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// N62 — a pool named `<otherPool>-<buildId>` collides two same-kind objects.
// ---------------------------------------------------------------------------
describe("N62: cross-pool emitted-name collision (pools `api` + `api-v2`, buildId `v2`)", () => {
  it("is detected by the guard, for a SINGLE build id", () => {
    const collision = findEmittedNameCollision("nextjs", ["api", "api-v2"], ["v2"]);
    expect(collision).not.toBeNull();
    // Pool `api`'s VERSIONED name == pool `api-v2`'s STABLE (active) name.
    expect(collision!.name).toBe("nextjs-api-v2");
    expect(collision!.kind).toBe("Deployment/Service");
    expect(sanitizeK8sName("nextjs-api-v2")).toBe("nextjs-api-v2");
  });

  it("is also detected through the blue/green pairwise entry point", () => {
    // deploy.ts / adapter.ts call the pairwise wrapper; it must see the same set.
    expect(findBuildIdNameCollision("nextjs", ["api", "api-v2"], "v2", "v1")).not.toBeNull();
  });

  it("does not false-positive on the same pools with a non-colliding build id", () => {
    expect(findEmittedNameCollision("nextjs", ["api", "api-v2"], ["v3"])).toBeNull();
    expect(findEmittedNameCollision("nextjs", ["api", "api-v2"], ["b12345", "b67890"])).toBeNull();
  });

  it("catches a pool composing into the reserved routing-tier name", () => {
    // config.ts reserves the literal pool name "routing-service"; it does NOT cover a pool
    // named `routing` whose versioned name (buildId `service`) is `<release>-routing-service`.
    expect(findEmittedNameCollision("nextjs", ["routing"], ["service"])).toEqual({
      kind: "Deployment/Service",
      name: "nextjs-routing-service",
    });
  });

  it.skipIf(!helmVersion())(
    "REGRESSION (real helm): the colliding pair renders two same-named Services in one chart",
    () => {
      // This is the rendered evidence the guard exists to prevent: helm emits BOTH
      // documents silently, last-writer-wins, so pool `api-v2`'s HTTPRoute backendRef can
      // resolve to pool `api`'s pods and the cutover patch flips the wrong object.
      const { ok, out } = helmRender({
        "templates/api-service.yaml": renderService({
          poolName: "api",
          buildId: "v2",
          releaseName: "nextjs",
        }),
        "templates/api-v2-active-service.yaml": renderActiveService({
          poolName: "api-v2",
          releaseName: "nextjs",
        }),
      });
      expect(ok).toBe(true);
      const serviceNames = (out.match(/^  name: nextjs-api-v2$/gm) ?? []).length;
      expect(serviceNames).toBe(2);
      // …with DIFFERENT selectors — one pinned to the build, one to activeBuildId.
      expect(out).toContain('app.kubernetes.io/version: "v2"');
      expect(out).toContain('app.kubernetes.io/version: "someBuild"');
    },
  );
});
