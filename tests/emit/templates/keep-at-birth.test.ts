// tests/emit/templates/keep-at-birth.test.ts
//
// GitOps PR2 keep-at-birth (design §4.2 "The sync itself must not delete the serving
// build"). Under `cutover.mode: job` a bundle is replaced WHOLESALE in Git, so the sync
// that applies build N's bundle would prune build N-1's Deployment — the build serving
// 100% of traffic, because the cutover Job has not run yet. Zero endpoints, site down,
// Job never reached. The fix is structural: every per-build resource carries all THREE
// engines' prune-protection annotations from its own bundle onward.
//
// All three are required and none substitutes for another: `keep` is a Helm semantic
// (helm-controller honors it; Argo does NOT — observed live, 2026-08-10), `Prune=false` is
// Argo's, `prune: disabled` is the Flux Kustomization's.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  keepAtBirthAnnotationEntries,
  renderKeepAtBirthAnnotations,
} from "../../../src/emit/templates/utils.js";
import { renderDeployment } from "../../../src/emit/templates/deployment.js";
import { renderHPA } from "../../../src/emit/templates/hpa.js";
import { renderActiveService, renderService } from "../../../src/emit/templates/service.js";
import { renderInternalSecret } from "../../../src/emit/templates/internal-secret.js";
import { renderRoutingManifestSnapshotConfigMap } from "../../../src/emit/templates/routing-manifest-configmap.js";
import { renderExternalSecrets } from "../../../src/emit/templates/external-secret.js";
import {
  compileTarget,
  defineTarget,
  kubernetesCluster,
  manualExposure,
} from "../../../src/target/index.js";
import { renderCompositionPlanConfigMap } from "../../../src/emit/templates/composition-plan-configmap.js";

const JOB_MODE_GATE = '{{- if and .Values.cutover (eq .Values.cutover.mode "job") }}';

const KEEP_ANNOTATIONS = [
  "helm.sh/resource-policy: keep",
  "argocd.argoproj.io/sync-options: Prune=false",
  "kustomize.toolkit.fluxcd.io/prune: disabled",
];

function helmAvailable(): boolean {
  try {
    execFileSync("helm", ["version", "--short"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

describe("renderKeepAtBirthAnnotations / keepAtBirthAnnotationEntries", () => {
  it("emits all THREE engines' annotations, gated on cutover.mode", () => {
    expect(renderKeepAtBirthAnnotations("  ")).toBe(
      `  ${JOB_MODE_GATE}\n` +
        "  annotations:\n" +
        "    helm.sh/resource-policy: keep\n" +
        "    argocd.argoproj.io/sync-options: Prune=false\n" +
        "    kustomize.toolkit.fluxcd.io/prune: disabled\n" +
        "  {{- end }}\n",
    );
    // The entries-only variant (for templates that already render `annotations:`) is the
    // SAME set at the caller's indent — migrate derives its kubectl args from it, so a
    // divergence would make the migrate path and the render path disagree.
    expect(keepAtBirthAnnotationEntries("    ")).toBe(
      "    helm.sh/resource-policy: keep\n" +
        "    argocd.argoproj.io/sync-options: Prune=false\n" +
        "    kustomize.toolkit.fluxcd.io/prune: disabled\n",
    );
    for (const a of KEEP_ANNOTATIONS) expect(renderKeepAtBirthAnnotations("  ")).toContain(a);
  });

  it("respects the caller's indent (the block sits under `metadata:`)", () => {
    const block = renderKeepAtBirthAnnotations("      ");
    expect(block).toContain(`      ${JOB_MODE_GATE}\n`);
    expect(block).toContain("      annotations:\n");
    expect(block).toContain("        helm.sh/resource-policy: keep\n");
    expect(block.endsWith("      {{- end }}\n")).toBe(true);
  });

  it("is wired into every per-build template (Deployment, HPA, versioned Service)", () => {
    const args = { poolName: "ssr", buildId: "b1", releaseName: "my-app" };
    for (const yaml of [renderDeployment(args), renderHPA(args), renderService(args)]) {
      expect(yaml).toContain(JOB_MODE_GATE);
      for (const a of KEEP_ANNOTATIONS) expect(yaml).toContain(a);
    }
  });

  it("is NOT wired into the stable active Service — the reconciler must keep managing it", () => {
    // The stable Services ARE in every bundle's manifest (their selector is the field the
    // Job patches and the recipes' ignore rules fence). Prune-protecting them would only
    // orphan them; they carry the explicit empty resource-policy instead.
    const yaml = renderActiveService({ poolName: "ssr", releaseName: "my-app" });
    expect(yaml).not.toContain("argocd.argoproj.io/sync-options");
    expect(yaml).not.toContain("kustomize.toolkit.fluxcd.io/prune");
    expect(yaml).toContain('helm.sh/resource-policy: ""');
  });

  it("stamps Argo/Flux prune protection on rollback-critical Secrets and ConfigMaps", () => {
    const secret = renderInternalSecret({
      releaseName: "my-app",
      buildId: "b1",
      secret: "x".repeat(64),
    });
    expect(secret).toContain("helm.sh/resource-policy: keep");
    expect(secret).toContain(JOB_MODE_GATE);
    for (const a of KEEP_ANNOTATIONS.slice(1)) expect(secret).toContain(a);

    const snapshot = renderRoutingManifestSnapshotConfigMap({
      releaseName: "my-app",
      buildId: "b1",
      routingManifestJson: "{}",
    });
    expect(snapshot).toContain("helm.sh/resource-policy");
    expect(snapshot).toContain(JOB_MODE_GATE);
    for (const a of KEEP_ANNOTATIONS.slice(1)) expect(snapshot).toContain(a);

    const { plan } = compileTarget(
      defineTarget({
        cluster: kubernetesCluster(),
        exposure: manualExposure({
          hosts: [{ hostname: "app.example.com", tls: { enabled: false } }],
        }),
      }),
      {
        releaseName: "my-app",
        namespace: "default",
        buildId: "b1",
        imageRegistry: "ghcr.io/example/app",
        pools: ["ssr"],
        defaultPool: "ssr",
        failurePolicy: "closed",
      },
    );
    const composition = renderCompositionPlanConfigMap(plan);
    expect(composition).toContain("helm.sh/resource-policy: keep");
    expect(composition).toContain(JOB_MODE_GATE);
    for (const a of KEEP_ANNOTATIONS.slice(1)) expect(composition).toContain(a);

    const external = renderExternalSecrets({
      releaseName: "my-app",
      buildId: "b1",
      includeValkey: false,
    });
    expect(external).toContain("helm.sh/resource-policy: keep");
    expect(external).toContain(JOB_MODE_GATE);
    for (const a of KEEP_ANNOTATIONS.slice(1)) expect(external).toContain(a);
  });
});

/** Render per-build templates with REAL helm at a given cutover.mode. */
function helmRender(mode: "none" | "job"): string {
  const dir = mkdtempSync(path.join(tmpdir(), "keep-at-birth-"));
  try {
    mkdirSync(path.join(dir, "templates"));
    writeFileSync(path.join(dir, "Chart.yaml"), "apiVersion: v2\nname: k\nversion: 0.0.0\n");
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
        "activeBuildId: b1",
        "activeDefaultPool: ssr",
        "previousBuildId: b0",
        "previousDefaultPool: ssr",
        "poolHealthCheckPath: /readyz",
        "cutover:",
        `  mode: ${mode}`,
        "  image: ghcr.io/next-community/adapter-k8s-cutover:latest",
        "  forcePromotion: false",
      ].join("\n") + "\n",
    );
    const args = { poolName: "ssr", buildId: "b1", releaseName: "my-app" };
    writeFileSync(path.join(dir, "templates", "deployment.yaml"), renderDeployment(args));
    writeFileSync(path.join(dir, "templates", "hpa.yaml"), renderHPA(args));
    writeFileSync(path.join(dir, "templates", "service.yaml"), renderService(args));
    return execFileSync("helm", ["template", "k", dir], { encoding: "utf8", stdio: "pipe" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Split a rendered multi-doc manifest into `kind -> document`. */
function documents(out: string): Map<string, string> {
  const docs = new Map<string, string>();
  for (const doc of out.split(/^---$/m)) {
    const kind = /^kind: (.+)$/m.exec(doc)?.[1];
    if (kind) docs.set(kind.trim(), doc);
  }
  return docs;
}

describe.skipIf(!helmAvailable())("real helm: keep-at-birth is mode-gated end to end", () => {
  it("cutover.mode: none renders the per-build resources with NO keep-at-birth annotations", () => {
    // The imperative-deploy path is unchanged: deploy performs the keep-TRANSFER on the
    // live outgoing objects instead, and PR1 bundles stay byte-identical to before.
    const out = helmRender("none");
    const docs = documents(out);
    expect([...docs.keys()].sort()).toEqual(["Deployment", "HorizontalPodAutoscaler", "Service"]);
    for (const [kind, doc] of docs) {
      for (const annotation of KEEP_ANNOTATIONS) {
        expect(`${kind}: ${doc}`).not.toContain(annotation);
      }
    }
  });

  it("cutover.mode: job stamps ALL THREE on the Deployment, the HPA, and the versioned Service", () => {
    const out = helmRender("job");
    const docs = documents(out);
    expect([...docs.keys()].sort()).toEqual(["Deployment", "HorizontalPodAutoscaler", "Service"]);
    for (const [kind, doc] of docs) {
      for (const annotation of KEEP_ANNOTATIONS) {
        // Named per kind so a failure says WHICH object a pruning sync would delete.
        expect(`${kind} is missing ${annotation}\n${doc}`).toContain(annotation);
      }
      // They land under metadata.annotations of the object itself (not the pod template).
      const metadataBlock = doc.slice(doc.indexOf("metadata:"), doc.indexOf("spec:"));
      expect(metadataBlock).toContain("annotations:");
      expect(metadataBlock).toContain("helm.sh/resource-policy: keep");
    }
    // Nothing else changes between the two modes for these objects — the annotations are
    // the ONLY delta, so flipping the gate cannot alter a workload's spec.
    const strip = (s: string) =>
      s
        .split("\n")
        .filter((l) => !KEEP_ANNOTATIONS.some((a) => l.includes(a)) && l.trim() !== "annotations:")
        .join("\n");
    expect(strip(out)).toBe(strip(helmRender("none")));
  });
});
