// tests/emit/templates/cutover-job.test.ts
//
// GitOps PR2 (design §4.2 + real-cluster gap #4): the in-cluster cutover Job's chart
// templates. The load-bearing properties are (a) PLAIN Job semantics — per-build name, no
// hook annotations, no TTL — because the target population is overwhelmingly Flux and Flux
// has no sync-hook machinery, so correctness may not depend on one; and (b) a
// namespace-scoped Role whose verbs are exactly what the moved cutover code executes.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  CUTOVER_JOB_COMPONENT,
  EMIT_METADATA_MOUNT_DIR,
  EMIT_METADATA_MOUNT_PATH,
  cutoverJobName,
  cutoverRoleName,
  cutoverServiceAccountName,
  emitMetadataConfigMapName,
  renderCutoverJob,
  renderCutoverRbac,
  renderEmitMetadataConfigMap,
} from "../../../src/emit/templates/cutover-job.js";
import { sanitizeK8sName } from "../../../src/emit/templates/utils.js";

const RELEASE = "my-app";
const BUILD = "buildn";
const VALUES_GATE = '{{- if eq .Values.cutover.mode "job" }}';

/** Every annotation any engine could read as "run me as a hook / sweep me". */
const HOOK_MARKERS = [
  "argocd.argoproj.io/hook",
  "argocd.argoproj.io/hook-delete-policy",
  "argocd.argoproj.io/sync-wave",
  "helm.sh/hook",
  "helm.sh/hook-weight",
  "helm.sh/hook-delete-policy",
  "ttlSecondsAfterFinished",
];

/**
 * The rendered manifest with `#` comment lines dropped. The templates document their own
 * decisions in comments ("NO ttlSecondsAfterFinished: …"), so absence assertions must look
 * at what the API server will actually see.
 */
function withoutComments(yaml: string): string {
  return yaml
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
}

describe("cutoverJobName / emitMetadataConfigMapName — per-build naming is the idempotency key", () => {
  it("names the Job per build with a 12-hex digest suffix (Jobs are immutable)", () => {
    const digest = createHash("sha256").update(BUILD).digest("hex").slice(0, 12);
    expect(cutoverJobName(RELEASE, BUILD)).toBe(`${RELEASE}-cutover-${digest}`);
    expect(cutoverJobName(RELEASE, BUILD)).toMatch(/^my-app-cutover-[0-9a-f]{12}$/);
    // Deterministic (the bundle is byte-deterministic) and distinct per build: a name
    // collision would make the second build's promotion a silent no-op, because the
    // completed first Job "is" the cutover.
    expect(cutoverJobName(RELEASE, BUILD)).toBe(cutoverJobName(RELEASE, BUILD));
    expect(cutoverJobName(RELEASE, "buildm")).not.toBe(cutoverJobName(RELEASE, BUILD));
    // The digest survives truncation, so two build ids sharing a long sanitized prefix
    // still get different Job names.
    const long = "b".repeat(120);
    expect(cutoverJobName(RELEASE, `${long}1`)).not.toBe(cutoverJobName(RELEASE, `${long}2`));
  });

  it("names the mounted metadata ConfigMap per build (a fresh NAME, never an update)", () => {
    // kubelet propagates UPDATES to a watched ConfigMap asynchronously; a never-seen name
    // is a fresh GET with no propagation window (the 2026-07-30 incident).
    const name = emitMetadataConfigMapName(RELEASE, BUILD);
    expect(name).toBe(
      sanitizeK8sName(
        `${RELEASE}-emit-meta-${BUILD}`,
        `-${createHash("sha256").update(BUILD).digest("hex").slice(0, 8)}`,
      ),
    );
    expect(name.length).toBeLessThanOrEqual(63);
    expect(emitMetadataConfigMapName(RELEASE, "buildm")).not.toBe(name);
    // Even when the base truncates away the build id entirely, the digest keeps it unique.
    const longRelease = "r".repeat(40);
    expect(emitMetadataConfigMapName(longRelease, "a".repeat(60))).not.toBe(
      emitMetadataConfigMapName(longRelease, "b".repeat(60)),
    );
  });

  it("keeps the SA/Role names stable (replaced in place by every sync)", () => {
    expect(cutoverServiceAccountName(RELEASE)).toBe("my-app-cutover-sa");
    expect(cutoverRoleName(RELEASE)).toBe("my-app-cutover");
  });
});

describe("renderCutoverJob", () => {
  const yaml = (opts: { pullSecrets?: string[] } = {}) =>
    renderCutoverJob({ releaseName: RELEASE, buildId: BUILD, ...opts });

  it("renders a per-build-named batch/v1 Job behind the cutover.mode values gate", () => {
    const out = yaml();
    expect(out.startsWith(VALUES_GATE)).toBe(true);
    expect(out.trimEnd().endsWith("{{- end }}")).toBe(true);
    expect(out).toContain("apiVersion: batch/v1");
    expect(out).toContain("kind: Job");
    expect(out).toContain(`  name: ${cutoverJobName(RELEASE, BUILD)}`);
    expect(out).toContain(
      `  name: ${cutoverJobName(RELEASE, BUILD)}{{ if .Values.cutover.forcePromotion }}-force{{ end }}`,
    );
    // The name carries only a digest, so the full build id rides an annotation (build ids
    // may exceed the 63-char label-value cap).
    expect(out).toContain(`adapter-k8s.dev/build-id: "${BUILD}"`);
    expect(out).toContain(`app.kubernetes.io/component: ${CUTOVER_JOB_COMPONENT}`);
  });

  it("gap #4: NO Helm/Argo hook annotations anywhere — it is a plain, Flux-native Job", () => {
    // Flux has no sync-hook machinery, so correctness may not depend on one. Argo PostSync
    // sugar is PR3 recipe scope; a hook annotation here would be load-bearing by accident.
    const out = withoutComments(yaml());
    for (const marker of HOOK_MARKERS) expect(out).not.toContain(marker);
    // ...and NO ttlSecondsAfterFinished: the per-build name IS the idempotency key, so a
    // re-sync must find the COMPLETED Job rather than a swept one it would re-create.
    expect(out).not.toContain("ttlSeconds");
    // The only annotation on the Job is the operator-facing full build id.
    const annotations = out.slice(out.indexOf("  annotations:")).split("\n").slice(1);
    const annotationKeys = annotations
      .slice(
        0,
        annotations.findIndex((l) => !/^ {4}\S/.test(l)),
      )
      .map((l) => l.trim().split(":")[0]);
    expect(annotationKeys).toEqual(["adapter-k8s.dev/build-id"]);
    // One retry absorbs a pod-level blip; the poison pill handles a persistently failing
    // build, so retries cannot flap the HPA warm-up.
    expect(out).toContain("backoffLimit: 1");
    expect(out).toContain("restartPolicy: Never");
  });

  it("wires the entrypoint's three inputs: release, downward-API namespace, mounted metadata", () => {
    const out = yaml();
    expect(out).toContain(`serviceAccountName: ${cutoverServiceAccountName(RELEASE)}`);
    expect(out).toContain(`value: "${RELEASE}"`);
    // The namespace comes from the downward API, never a values echo that could disagree
    // with where the bundle was actually applied.
    expect(out).toContain("fieldPath: metadata.namespace");
    expect(out).toContain(`value: ${EMIT_METADATA_MOUNT_PATH}`);
    expect(out).toContain(`mountPath: ${EMIT_METADATA_MOUNT_DIR}`);
    expect(out).toContain(`name: ${emitMetadataConfigMapName(RELEASE, BUILD)}`);
    // The poison-pill override is values-driven and OFF by default (values-yaml.ts).
    expect(out).toContain("name: FORCE_PROMOTION");
    expect(out).toContain("{{ .Values.cutover.forcePromotion | quote }}");
    expect(out).toContain("image: {{ .Values.cutover.image | quote }}");
    // Hardened pod: the Job holds patch rights on the release's Services.
    expect(out).toContain("runAsNonRoot: true");
    expect(out).toContain("readOnlyRootFilesystem: true");
    expect(out).toContain('drop: ["ALL"]');
  });

  it("gap #2: renders imagePullSecrets on the Job pod when configured, and nothing otherwise", () => {
    // The Job pod pulls the cutover image from the same private registry the pools use.
    const withSecrets = yaml({ pullSecrets: ["regcred", "backup-regcred"] });
    expect(withSecrets).toContain(
      '      imagePullSecrets:\n        - name: "regcred"\n        - name: "backup-regcred"\n',
    );
    // Indented inside the pod spec, i.e. a sibling of serviceAccountName/restartPolicy.
    const podSpec = withSecrets.split("    spec:\n")[1]!;
    expect(podSpec).toMatch(/^ {6}imagePullSecrets:$/m);

    expect(yaml()).not.toContain("imagePullSecrets");
    expect(yaml({ pullSecrets: [] })).not.toContain("imagePullSecrets");
    // Validated at the point of consumption, like every other name in the template.
    expect(() => yaml({ pullSecrets: ["BAD SECRET"] })).toThrow(/Invalid/);
  });

  it("validates release and build ids at the template boundary (assertSafe*)", () => {
    expect(() => renderCutoverJob({ releaseName: "BAD", buildId: BUILD })).toThrow(
      /Invalid releaseName/,
    );
    expect(() => renderCutoverJob({ releaseName: RELEASE, buildId: 'a"\nx: y' })).toThrow(
      /Invalid buildId/,
    );
  });
});

/** Parse the rendered Role's rules into `apiGroup/resource -> verbs`. */
function roleRules(yaml: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const re = /- apiGroups: \[(.*)\]\n\s+resources: \[(.*)\]\n\s+verbs: \[(.*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(yaml))) {
    const groups = JSON.parse(`[${m[1]}]`) as string[];
    const resources = JSON.parse(`[${m[2]}]`) as string[];
    const verbs = JSON.parse(`[${m[3]}]`) as string[];
    for (const g of groups) for (const r of resources) out.set(g ? `${g}/${r}` : r, verbs);
  }
  return out;
}

describe("renderCutoverRbac — namespace-scoped, verb-minimal", () => {
  const out = renderCutoverRbac({ releaseName: RELEASE });

  it("emits ServiceAccount + Role + RoleBinding behind the values gate, and NOTHING cluster-scoped", () => {
    expect(out.startsWith(VALUES_GATE)).toBe(true);
    expect(out).toContain("kind: ServiceAccount");
    expect(out).toContain("kind: Role\n");
    expect(out).toContain("kind: RoleBinding");
    // A cluster-scoped grant is the thing an operator reviewing this bundle would refuse:
    // the CRD probe in gc.ts degrades with a warning instead, and GKE HealthCheckPolicy
    // cleanup is a best-effort no-op on the clusters this mode targets.
    expect(out).not.toContain("ClusterRole");
    expect(out).not.toContain("ClusterRoleBinding");
    expect(out).not.toContain("customresourcedefinitions");
    expect(out).not.toContain("nodes");
    expect(out).toContain(`  kind: Role\n  name: ${cutoverRoleName(RELEASE)}`);
    expect(out).toContain(`    name: ${cutoverServiceAccountName(RELEASE)}`);
  });

  it("grants exactly the verbs the moved cutover code executes — no wildcards", () => {
    const rules = roleRules(out);
    expect(Object.fromEntries(rules)).toEqual({
      // E1 selector cutover/revert (get + patch by name), E6 versioned-Service deletes.
      services: ["get", "list", "patch", "delete"],
      // D1/D2 rollout waits (get/list/watch), N64 live replica read, edge revert patch,
      // E6 deletes.
      "apps/deployments": ["get", "list", "watch", "patch", "delete"],
      // kubectl scale (D6 capacity match, E5 park-at-zero) hits the scale subresource.
      "apps/deployments/scale": ["patch", "update"],
      // D6 warm-up patch, E5 delete, the revert path's `kubectl autoscale` create.
      "autoscaling/horizontalpodautoscalers": ["get", "list", "create", "patch", "delete"],
      // D7 lists pods and reads Ready; the diagnostics exec /readyz and read logs.
      pods: ["get", "list"],
      "pods/exec": ["create"],
      "pods/log": ["get"],
      // D3 waits on the route-ext Job; E6 GCs superseded ones.
      "batch/jobs": ["get", "list", "watch", "delete"],
      // The state ConfigMap (create/replace under the N23 precondition), snapshot
      // retention (annotate/label = patch), E6 pruning.
      configmaps: ["get", "list", "create", "update", "patch", "delete"],
      // The edge revert probes the target build's dispatch Secret by name (N87); E6 prunes.
      secrets: ["get", "list", "delete"],
      // E6's retained stable-resource sweep lists PDBs by label, reads each to confirm it
      // selects the pool it claims to, and deletes the obsolete ones.
      "policy/poddisruptionbudgets": ["get", "list", "delete"],
      // D4/D5 generation-guarded Accepted gate — read-only.
      "gateway.envoyproxy.io/envoyextensionpolicies": ["get"],
      // Composition-plan readiness — HTTPRoute/Gateway/Certificate/Ingress/EndpointSlice.
      "gateway.networking.k8s.io/httproutes": ["get", "list"],
      "gateway.networking.k8s.io/gateways": ["get", "list"],
      "cert-manager.io/certificates": ["get", "list"],
      "discovery.k8s.io/endpointslices": ["get", "list"],
      "networking.k8s.io/ingresses": ["get", "list"],
    });
    for (const verbs of rules.values()) expect(verbs).not.toContain("*");
    expect(out).not.toContain('resources: ["*"]');
  });

  it("never grants WRITE on the objects the Job only reads", () => {
    const rules = roleRules(out);
    // The policy gate is a poll, never a repair.
    expect(rules.get("gateway.envoyproxy.io/envoyextensionpolicies")).toEqual(["get"]);
    expect(rules.get("gateway.networking.k8s.io/httproutes")).toEqual(["get", "list"]);
    expect(rules.get("cert-manager.io/certificates")).toEqual(["get", "list"]);
    // Dispatch Secrets are probed and pruned — never created or mutated (their material
    // is the chart's/the external store's business).
    expect(rules.get("secrets")).not.toContain("create");
    expect(rules.get("secrets")).not.toContain("patch");
    expect(rules.get("secrets")).not.toContain("update");
    // Pod exec is create-only on the subresource; pods themselves are read-only.
    expect(rules.get("pods")).toEqual(["get", "list"]);
  });

  it("grants E6's retained stable-PDB sweep exactly what it executes", () => {
    // gcSupersededResources → cleanupRetainedStablePoolResources lists retained
    // `poddisruptionbudget` objects by label, reads each to verify it selects the pool it
    // claims to, and deletes the obsolete ones. The sweep is post-state-commit and
    // best-effort, so a missing rule did not fail promotions — it just logged "Retained
    // stable-resource cleanup incomplete" on every Job and leaked PDBs from removed pools.
    const rules = roleRules(renderCutoverRbac({ releaseName: RELEASE }));
    expect(rules.get("policy/poddisruptionbudgets")).toEqual(["get", "list", "delete"]);
    // HealthCheckPolicy is the deliberately-degraded case: without the cluster-scoped CRD
    // probe the sweep never classifies HCPs at all, so no rule is needed.
    expect(rules.has("networking.gke.io/healthcheckpolicies")).toBe(false);
  });

  it("validates the release name at the template boundary", () => {
    expect(() => renderCutoverRbac({ releaseName: "Bad_Release" })).toThrow(/Invalid releaseName/);
  });
});

describe("renderEmitMetadataConfigMap — the facts the Job mounts", () => {
  const json = JSON.stringify({ buildId: BUILD, poolTopology: ["ssr"] }, null, 2);

  it("carries the emit-metadata JSON verbatim under the per-build name and values gate", () => {
    const out = renderEmitMetadataConfigMap({
      releaseName: RELEASE,
      buildId: BUILD,
      emitMetadataJson: json,
    });
    expect(out.startsWith(VALUES_GATE)).toBe(true);
    expect(out).toContain(`  name: ${emitMetadataConfigMapName(RELEASE, BUILD)}`);
    expect(out).toContain(`app.kubernetes.io/version: "${sanitizeK8sName(BUILD)}"`);
    expect(out).toContain("helm.sh/resource-policy: keep");
    expect(out).toContain("argocd.argoproj.io/sync-options: Prune=false");
    expect(out).toContain("kustomize.toolkit.fluxcd.io/prune: disabled");
    expect(out).toContain("  emit-metadata.json: |-");
    // Every line of the body is indented into the block scalar, unchanged otherwise.
    for (const line of json.split("\n")) expect(out).toContain(`    ${line}`);
  });

  it("escapes Helm actions in the embedded JSON (the chart is committed to a shared repo)", () => {
    const hostile = JSON.stringify({
      buildId: BUILD,
      note: '{{ index (lookup "v1" "Secret" "ns" "n").data "token" }}',
    });
    const out = renderEmitMetadataConfigMap({
      releaseName: RELEASE,
      buildId: BUILD,
      emitMetadataJson: hostile,
    });
    expect(out).toContain('{{ "{{" }}');
    expect(out).not.toContain("{{ index (lookup");
  });

  it("validates release and build ids at the template boundary", () => {
    expect(() =>
      renderEmitMetadataConfigMap({ releaseName: "BAD", buildId: BUILD, emitMetadataJson: json }),
    ).toThrow(/Invalid releaseName/);
    expect(() =>
      renderEmitMetadataConfigMap({
        releaseName: RELEASE,
        buildId: "bad build",
        emitMetadataJson: json,
      }),
    ).toThrow(/Invalid buildId/);
  });
});
