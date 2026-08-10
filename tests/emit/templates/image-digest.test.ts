// tests/emit/templates/image-digest.test.ts
//
// S7 (SECURITY). Pool and routing-service images were deployed by a MUTABLE `:<buildId>` tag
// while the deploy identity holds registry write access — and that identity is assumable by
// anyone who can create a Pod in the namespace (Workload Identity), while the pods carry
// INTERNAL_HEADER_SECRET and the cache credentials in env. A retag of an already-deployed
// build id therefore changed what the pool runs on its next restart or scale-up, turning
// pod-creation into dispatch-secret theft and from there a cluster-wide middleware bypass.
//
// The digest cannot be known when the chart is generated (`next build` runs before
// `docker push`), so the templates defer the choice to helm via `pools.<pool>.image.digest` /
// `routingService.image.digest`, which `deploy` sets from `docker inspect` after the push.
// These tests render with REAL helm because the whole point is which arm helm takes.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderDeployment } from "../../../src/emit/templates/deployment.js";
import { renderRoutingServiceDeployment } from "../../../src/emit/templates/routing-service-deployment.js";

function helmAvailable(): boolean {
  try {
    execFileSync("helm", ["version", "--short"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const DIGEST = `sha256:${"a".repeat(64)}`;

function render(body: string, sets: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "img-digest-"));
  try {
    mkdirSync(path.join(dir, "templates"));
    writeFileSync(path.join(dir, "Chart.yaml"), "apiVersion: v2\nname: p\nversion: 0.0.0\n");
    writeFileSync(
      path.join(dir, "values.yaml"),
      [
        "global:",
        "  image:",
        "    registry: gcr.io/proj",
        "    tag: b1",
        "pools:",
        "  ssr:",
        "    image:",
        "      repository: nextjs-app-ssr",
        '      digest: ""',
        "    replicas: { min: 1, max: 3, targetCPU: 60 }",
        "    resources:",
        "      requests: { cpu: 100m, memory: 512Mi }",
        "      limits: { cpu: 1, memory: 1Gi }",
        "routingService:",
        "  image:",
        '    digest: ""',
        "activeBuildId: b1",
        // Mirrors the chart's own default (values-yaml.ts). Since GitOps PR2 the per-build
        // templates gate keep-at-birth annotations on `.Values.cutover.mode`; without the
        // key helm fails with a nil-pointer before reaching the digest seam under test.
        "cutover:",
        "  mode: none",
      ].join("\n") + "\n",
    );
    writeFileSync(path.join(dir, "templates", "obj.yaml"), body);
    return execFileSync("helm", ["template", "p", dir, ...sets.flatMap((s) => ["--set", s])], {
      encoding: "utf8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!helmAvailable())("real helm: image digest seam (S7)", () => {
  const pool = () => renderDeployment({ poolName: "ssr", buildId: "b1", releaseName: "my-app" });
  const routing = () =>
    renderRoutingServiceDeployment({
      releaseName: "my-app",
      buildId: "b1",
      imageRegistry: "gcr.io/proj",
    });

  it("pool: no digest in values ⇒ tag + Always (a retag must never be served from cache)", () => {
    const out = render(pool(), []);
    expect(out).toContain('image: "gcr.io/proj/nextjs-app-ssr:b1"');
    expect(out).toContain("imagePullPolicy: Always");
    expect(out).not.toContain("@sha256:");
  });

  it("pool: digest in values ⇒ immutable reference + IfNotPresent", () => {
    const out = render(pool(), [`pools.ssr.image.digest=${DIGEST}`]);
    expect(out).toContain(`image: "gcr.io/proj/nextjs-app-ssr@${DIGEST}"`);
    expect(out).toContain("imagePullPolicy: IfNotPresent");
    expect(out).not.toContain("nextjs-app-ssr:b1");
  });

  it("routing service: same seam, both arms", () => {
    const tagged = render(routing(), []);
    expect(tagged).toContain('image: "gcr.io/proj/routing-service:b1"');
    expect(tagged).toContain("imagePullPolicy: Always");

    const pinned = render(routing(), [`routingService.image.digest=${DIGEST}`]);
    expect(pinned).toContain(`image: "gcr.io/proj/routing-service@${DIGEST}"`);
    expect(pinned).toContain("imagePullPolicy: IfNotPresent");
  });

  it("a render-time digest still wins outright (the pre-existing N72 path)", () => {
    const out = render(
      renderDeployment({
        poolName: "ssr",
        buildId: "b1",
        releaseName: "my-app",
        imageDigest: DIGEST,
      }),
      [],
    );
    expect(out).toContain(`@${DIGEST}`);
    expect(out).toContain("imagePullPolicy: IfNotPresent");
  });
});
