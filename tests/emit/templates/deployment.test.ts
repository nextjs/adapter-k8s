import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { READINESS_PATH } from "../../../src/pool-server/server.js";
import {
  renderDeployment,
  POOL_READINESS_PATH,
  EPHEMERAL_STORAGE_REQUEST,
  NEXT_CACHE_SIZE_LIMIT,
  PRESTOP_DRAIN_SECONDS,
  TERMINATION_GRACE_SECONDS,
  TMP_SIZE_LIMIT,
} from "../../../src/emit/templates/deployment.js";
import { renderValuesYaml } from "../../../src/emit/templates/values-yaml.js";
import type { K8sAdapterConfig, PoolDefinition } from "../../../src/types.js";

// Comments SHIP in the rendered chart (this repo treats them as institutional memory), so
// an absence assertion about the manifest must look at the manifest, not the prose.
const yamlOnly = (doc: string) =>
  doc
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

describe("renderDeployment", () => {
  it("renders a retained build with the canonical pod template", () => {
    const yaml = renderDeployment({
      poolName: "ssr",
      buildId: "old123",
      releaseName: "my-app",
      imageTag: "old123",
      replicas: 3,
    });

    expect(yaml).toContain("replicas: 3");
    expect(yaml).toContain("NEXT_BUILD_ID");
    expect(yaml).toContain('value: "old123"');
    expect(yaml).toContain("RELEASE_NAME");
    expect(yaml).toContain('adapter-k8s.dev/release: "my-app"');
    // S7: the tag is now the `{{ else }}` arm of the values-digest conditional — the render
    // still pins this retained build to its own tag, helm just picks tag-vs-digest.
    expect(yaml).toContain(':old123{{ end }}"');
    expect(yaml).toContain("resources:");
    expect(yaml).toContain('.resources.requests.cpu }}"');
    expect(yaml).toContain('.resources.limits.memory }}"');
  });

  it("always injects the optional Valkey env from the release secret", () => {
    // Emitted unconditionally (optional:true) so toggling cache.enabled never rolls the retained
    // previous deployment; the pool only registers the handler when VALKEY_URL is actually set.
    const yaml = renderDeployment({ poolName: "ssr", buildId: "b1", releaseName: "my-app" });
    expect(yaml).toContain("name: VALKEY_URL");
    expect(yaml).toContain("name: VALKEY_AUTH");
    expect(yaml).toContain("name: my-app-valkey");
    // optional so a missing secret never blocks pod startup
    expect(yaml).toContain("optional: true");
  });

  it("ships the hardened pod/container security posture", () => {
    const yaml = renderDeployment({ poolName: "ssr", buildId: "b1", releaseName: "my-app" });
    // Pod level: non-root uid 1000 (the node user), seccomp, no SA token (the pool
    // never calls the Kubernetes API).
    expect(yaml).toContain("automountServiceAccountToken: false");
    expect(yaml).toContain("runAsNonRoot: true");
    expect(yaml).toContain("runAsUser: 1000");
    expect(yaml).toContain("fsGroup: 1000");
    expect(yaml).toContain("seccompProfile:");
    expect(yaml).toContain("type: RuntimeDefault");
    // Container level: no privilege escalation, read-only root FS, all caps dropped.
    expect(yaml).toContain("allowPrivilegeEscalation: false");
    expect(yaml).toContain("readOnlyRootFilesystem: true");
    expect(yaml).toContain('drop: ["ALL"]');
    expect(yaml).toContain('kubernetes.io/arch: "amd64"');
    // A writable /tmp (emptyDir) backs the read-only root filesystem — with a sizeLimit,
    // and NOT described as in-memory (a bare emptyDir is node-disk-backed).
    expect(yaml).toMatch(/volumeMounts:[\s\S]*?name: tmp\n\s+mountPath: \/tmp/);
    expect(yaml).toMatch(/volumes:[\s\S]*?name: tmp\n\s+emptyDir:\n\s+sizeLimit: 256Mi/);
    // .next/cache stays writable for Next's filesystem-cache fallback when no shared
    // Valkey handler is wired (otherwise renders fail with EROFS).
    expect(yaml).toMatch(/name: next-cache\n\s+mountPath: \/app\/\.next\/cache/);
    expect(yaml).toMatch(/name: next-cache\n\s+emptyDir:\n\s+sizeLimit: 1Gi/);
  });

  it("does NOT set TRUST_INTERNAL_HEADERS — the legacy bypass must not ship in the chart", () => {
    const yaml = renderDeployment({ poolName: "ssr", buildId: "b1", releaseName: "my-app" });
    expect(yaml).not.toContain("TRUST_INTERNAL_HEADERS");
  });

  // ---------------------------------------------------------------------------
  // N63 — preStop + terminationGracePeriodSeconds
  // ---------------------------------------------------------------------------
  it("N63: gives pool pods a preStop drain hook AND a matching grace period", () => {
    const yaml = renderDeployment({ poolName: "ssr", buildId: "b1", releaseName: "my-app" });
    // Google, "Troubleshoot load balancing in GKE": preStop sleep 120s, grace 3.5 min.
    expect(PRESTOP_DRAIN_SECONDS).toBe(120);
    expect(TERMINATION_GRACE_SECONDS).toBe(210);
    expect(yaml).toContain(`terminationGracePeriodSeconds: ${TERMINATION_GRACE_SECONDS}`);
    expect(yaml).toMatch(
      /lifecycle:\n\s+preStop:\n(?:\s+#.*\n)*\s+exec:\n\s+command: \["\/bin\/sh", "-c", "sleep 120"\]/,
    );
    // The grace period must EXCEED the hook, or SIGKILL lands mid-drain.
    expect(TERMINATION_GRACE_SECONDS).toBeGreaterThan(PRESTOP_DRAIN_SECONDS);
  });

  // ---------------------------------------------------------------------------
  // N64 — new builds no longer start at exactly 1 replica
  // ---------------------------------------------------------------------------
  it("N64: seeds the current build's replicas from the pool's HPA floor, not the apiserver default of 1", () => {
    const yaml = renderDeployment({ poolName: "ssr", buildId: "b1", releaseName: "my-app" });
    // `replicas` present at all is the fix: omitting it let the apiserver default to 1
    // while deploy renders the PREVIOUS build at its live count.
    expect(yaml).toContain('replicas: {{ (index .Values.pools "ssr").replicas.min }}');
    // The value is the same one hpa.ts uses for minReplicas, so a new build can never
    // start below the autoscaler's own floor.
    expect(yaml).toMatch(/spec:\n {2}replicas:/);
  });

  it("N64: an explicit replicas literal still wins", () => {
    const yaml = renderDeployment({
      poolName: "ssr",
      buildId: "b1",
      releaseName: "my-app",
      replicas: 6,
    });
    expect(yaml).toContain("replicas: 6");
    expect(yaml).not.toContain("replicas.min }}");
  });

  it("N64: rejects a non-integer replica count (bare YAML scalar sink)", () => {
    expect(() =>
      renderDeployment({
        poolName: "ssr",
        buildId: "b1",
        releaseName: "my-app",
        replicas: "1\n  hostNetwork: true" as unknown as number,
      }),
    ).toThrow(/Invalid replicas/);
    expect(() =>
      renderDeployment({ poolName: "ssr", buildId: "b1", releaseName: "my-app", replicas: 1.5 }),
    ).toThrow(/Invalid replicas/);
  });

  // ---------------------------------------------------------------------------
  // N65 — anti-affinity
  // ---------------------------------------------------------------------------
  it("N65: spreads a build's replicas across hostnames, softly", () => {
    const yaml = renderDeployment({ poolName: "ssr", buildId: "b1", releaseName: "my-app" });
    expect(yaml).toContain("topologySpreadConstraints:");
    expect(yaml).toContain("topologyKey: kubernetes.io/hostname");
    // ScheduleAnyway, never DoNotSchedule: a hard constraint would fail a scale-up on a
    // small node pool, turning a capacity event into an outage.
    expect(yaml).toContain("whenUnsatisfiable: ScheduleAnyway");
    expect(yamlOnly(yaml)).not.toContain("DoNotSchedule");
    // Scoped to THIS build's pods, so a cutover's two builds spread independently.
    expect(yaml).toMatch(
      /topologySpreadConstraints:[\s\S]*?labelSelector:\n\s+matchLabels:\n\s+app\.kubernetes\.io\/name: "my-app"\n\s+app\.kubernetes\.io\/component: "ssr"\n\s+app\.kubernetes\.io\/version: "b1"/,
    );
  });

  // ---------------------------------------------------------------------------
  // N61 — YAML-boolean pool names
  // ---------------------------------------------------------------------------
  it("N61: quotes the pool name in every label and selector, so a YAML-boolean name survives", () => {
    // Verified against the real apiserver decode path before the fix: an unquoted
    //   app.kubernetes.io/component: on
    // renders a YAML 1.1 BOOLEAN. `helm template` exits 0, then
    //   kubectl create --dry-run=client -f -
    // reports: "unable to decode …: json: cannot unmarshal bool into Go struct field
    // ObjectMeta.metadata.labels of type string" (sigs.k8s.io/yaml -> go-yaml v2).
    for (const poolName of ["on", "no", "y", "off", "true", "123"]) {
      const yaml = renderDeployment({ poolName, buildId: "b1", releaseName: "my-app" });
      const componentLines = yaml.match(/^\s*app\.kubernetes\.io\/component: .*$/gm) ?? [];
      expect(componentLines.length).toBeGreaterThanOrEqual(4); // labels, selector, pod, spread
      for (const line of componentLines) {
        expect(line).toMatch(/component: "(on|no|y|off|true|123)"$/);
      }
      // No bare YAML 1.1 boolean/int anywhere in the document.
      expect(yaml).not.toMatch(/component: (on|off|no|yes|y|n|true|false|[0-9]+)\s*$/m);
    }
  });

  it("N61: rejects a pool name with a leading or trailing hyphen (invalid label value)", () => {
    expect(() =>
      renderDeployment({ poolName: "-api", buildId: "b1", releaseName: "my-app" }),
    ).toThrow(/Invalid pool name/);
    expect(() =>
      renderDeployment({ poolName: "api-", buildId: "b1", releaseName: "my-app" }),
    ).toThrow(/Invalid pool name/);
  });

  it("sanitizes releaseName / buildId at the consumption point (buildId went raw into an env value)", () => {
    expect(() =>
      renderDeployment({ poolName: "ssr", buildId: 'a"\n  x: y', releaseName: "my-app" }),
    ).toThrow(/Invalid buildId/);
    expect(() =>
      renderDeployment({ poolName: "ssr", buildId: "b1", releaseName: 'x";rm -rf /;"' }),
    ).toThrow(/Invalid releaseName/);
  });

  // ---------------------------------------------------------------------------
  // Direct literal overrides
  // ---------------------------------------------------------------------------
  it("literal resources + image render with no .Values lookups", () => {
    const yaml = renderDeployment({
      poolName: "ssr",
      buildId: "old123",
      releaseName: "my-app",
      replicas: 4,
      image: "us-central1-docker.pkg.dev/p/r/nextjs-app-ssr:old123",
      resources: { cpu: "500m", memory: "1Gi", cpuLimit: "2", memoryLimit: "2Gi" },
    });
    // A fully literal direct render contains no deferred Helm values.
    expect(yaml).not.toContain(".Values");
    expect(yaml).not.toContain("{{");
    expect(yaml).toContain('image: "us-central1-docker.pkg.dev/p/r/nextjs-app-ssr:old123"');
    expect(yaml).toContain('cpu: "500m"');
    expect(yaml).toContain('memory: "1Gi"');
    expect(yaml).toContain('cpu: "2"');
    expect(yaml).toContain('memory: "2Gi"');
    expect(yaml).toContain("replicas: 4");
  });

  it("rejects an unsafe literal image reference", () => {
    expect(() =>
      renderDeployment({
        poolName: "ssr",
        buildId: "b1",
        releaseName: "my-app",
        image: 'reg/app:tag"\n      hostNetwork: true\n      _pad: "',
      }),
    ).toThrow(/Invalid image reference/);
  });

  it("N60: rejects an injected literal resource quantity", () => {
    expect(() =>
      renderDeployment({
        poolName: "ssr",
        buildId: "b1",
        releaseName: "my-app",
        resources: { memoryLimit: '512Mi"\n      hostNetwork: true\n      _pad: "' },
      }),
    ).toThrow(/Invalid Kubernetes quantity/);
  });

  // ---------------------------------------------------------------------------
  // N69 — ephemeral storage
  // ---------------------------------------------------------------------------
  it("N69: bounds both emptyDirs and requests ephemeral-storage explicitly", () => {
    const yaml = renderDeployment({ poolName: "ssr", buildId: "b1", releaseName: "my-app" });
    expect(yaml).toContain(`sizeLimit: ${TMP_SIZE_LIMIT}`);
    expect(yaml).toContain(`sizeLimit: ${NEXT_CACHE_SIZE_LIMIT}`);
    expect(yaml).toContain(`ephemeral-storage: "${EPHEMERAL_STORAGE_REQUEST}"`);
    // The comment that called /tmp "an in-memory emptyDir" was wrong — a bare
    // `emptyDir: {}` is node-disk-backed; in-memory needs `medium: Memory`, which the
    // chart deliberately does not use (it would charge the pages to the memory limit).
    expect(yamlOnly(yaml)).not.toContain("medium: Memory");
    // …and the comment no longer claims it is in-memory.
    expect(yaml).not.toMatch(/\/tmp is an in-memory emptyDir/);
    // Sum of the volume caps must fit the request, or the pod evicts before either cap.
    const mib = (q: string) => (q.endsWith("Gi") ? parseInt(q) * 1024 : parseInt(q));
    expect(mib(TMP_SIZE_LIMIT) + mib(NEXT_CACHE_SIZE_LIMIT)).toBeLessThan(
      mib(EPHEMERAL_STORAGE_REQUEST),
    );
  });

  // ---------------------------------------------------------------------------
  // N71 — probes
  // ---------------------------------------------------------------------------
  it("N71: adds a startupProbe and explicit timings on every probe", () => {
    const yaml = renderDeployment({ poolName: "ssr", buildId: "b1", releaseName: "my-app" });
    // A slow boot must not be a restart loop: the HTTP listener comes up at the END of
    // startPoolServer, so everything before listen() is connection-refused.
    expect(yaml).toMatch(
      /startupProbe:\n\s+httpGet:\n\s+path: \/healthz\n\s+port: 3000\n\s+periodSeconds: 5\n\s+timeoutSeconds: 3\n\s+failureThreshold: 30/,
    );
    // No probe inherits the 1s default timeout (which fails while the event loop is
    // blocked by module loading or a heavy render).
    expect(yamlOnly(yaml)).not.toMatch(/timeoutSeconds: 1$/m);
    for (const probe of ["readinessProbe", "livenessProbe"]) {
      const block = yamlOnly(yaml).slice(yamlOnly(yaml).indexOf(`${probe}:`));
      expect(block).toMatch(/periodSeconds: \d+/);
      expect(block).toMatch(/timeoutSeconds: [2-9]/);
      expect(block).toMatch(/failureThreshold: \d+/);
    }
    // initialDelaySeconds is redundant once a startupProbe exists (and delayed the first
    // readiness signal by a fixed 5s on every pod).
    expect(yamlOnly(yaml)).not.toContain("initialDelaySeconds");
  });

  it("N71: readiness points at the pool server's /readyz; liveness and startup stay on /healthz", () => {
    // `/healthz` returns a hardcoded 200 before any routing, handler load, or manifest
    // check, so a build whose instrumentation register() throws (or whose Next output can't
    // be imported) passed the probe AND the cutover gate while every app route 500'd.
    // The path must stay byte-identical to the pool server's own constant.
    expect(POOL_READINESS_PATH).toBe(READINESS_PATH);
    const readyz = renderDeployment({ poolName: "ssr", buildId: "b1", releaseName: "my-app" });
    expect(readyz).toMatch(/readinessProbe:\n\s+httpGet:\n\s+path: \/readyz/);
    // Liveness must NEVER follow readiness onto an endpoint that legitimately 503s, or a
    // pod that is merely not-yet-serving gets restarted.
    expect(readyz).toMatch(/livenessProbe:\n\s+httpGet:\n\s+path: \/healthz/);
    expect(readyz).toMatch(/startupProbe:\n\s+httpGet:\n\s+path: \/healthz/);
  });

  // ---------------------------------------------------------------------------
  // N72 — image pinning
  // ---------------------------------------------------------------------------
  it("N72: sets imagePullPolicy explicitly — Always for a mutable tag, IfNotPresent for a digest", () => {
    const tagged = renderDeployment({ poolName: "ssr", buildId: "b1", releaseName: "my-app" });
    // A mutable tag + a cached layer on an existing node means a rollout and a scale-up
    // can run different code under one build id (registry write access is assumable).
    // S7: with no render-time digest the choice is deferred to HELM, because the digest is
    // only knowable after `docker push` and arrives as `pools.<pool>.image.digest` in values.
    // Both branches are asserted through a real helm render below.
    expect(tagged).toContain(
      '{{ with (index .Values.pools "ssr").image.digest }}IfNotPresent{{ else }}Always{{ end }}',
    );

    const digest = `sha256:${"a".repeat(64)}`;
    const pinned = renderDeployment({
      poolName: "ssr",
      buildId: "b1",
      releaseName: "my-app",
      imageDigest: digest,
    });
    expect(pinned).toContain(`@${digest}"`);
    expect(pinned).not.toContain(":{{ .Values.global.image.tag }}");
    expect(pinned).toContain("imagePullPolicy: IfNotPresent");

    // A literal image that already carries a digest is immutable too.
    const literalDigest = renderDeployment({
      poolName: "ssr",
      buildId: "b1",
      releaseName: "my-app",
      image: `reg.example.com/p/nextjs-app-ssr@${digest}`,
    });
    expect(literalDigest).toContain("imagePullPolicy: IfNotPresent");
  });

  it("N72: rejects a malformed digest", () => {
    expect(() =>
      renderDeployment({
        poolName: "ssr",
        buildId: "b1",
        releaseName: "my-app",
        imageDigest: "sha256:nope",
      }),
    ).toThrow(/Invalid image digest/);
  });
});

// ---------------------------------------------------------------------------
// N60 (SECURITY) — differential render through REAL helm.
//
// This is the test that turns the finding from a claim into a fact: the payload below,
// before the fix, produced a rendered pod spec containing `hostNetwork: true`, which per
// N19 (network-policy.ts) voids BOTH NetworkPolicy postures ("Neither GKE Dataplane V2 nor
// Calico enforce network policies for Pods that use the spec.hostNetwork: true setting").
// ---------------------------------------------------------------------------
function helmVersion(): string | null {
  try {
    return execFileSync("helm", ["version", "--short"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const POD_SPEC_INJECTION_PAYLOAD =
  '512Mi"\n      hostNetwork: true\n      shareProcessNamespace: true\n      _pad: "';

describe("N60: pod-spec injection through pools.*.resources (values.yaml -> helm sink)", () => {
  const poolsMap = (resources?: Record<string, string>) =>
    new Map<string, PoolDefinition>([
      [
        "ssr",
        {
          name: "ssr",
          outputs: [],
          config: { routes: ["appPages"], ...(resources ? { resources } : {}) },
        } as unknown as PoolDefinition,
      ],
    ]);

  const config = {
    pools: { ssr: { routes: ["appPages"] } },
    provider: { gke: {} },
  } as unknown as K8sAdapterConfig;

  it("renderValuesYaml refuses to emit the payload at all", () => {
    expect(() =>
      renderValuesYaml({
        pools: poolsMap({ memoryLimit: POD_SPEC_INJECTION_PAYLOAD }),
        buildId: "b1",
        nextVersion: "16.2.0",
        config,
        imageRegistry: "us-docker.pkg.dev/p/r",
      }),
    ).toThrow(/Invalid Kubernetes quantity/);
  });

  it.skipIf(!helmVersion())(
    "a valid chart renders no pod-level keys beyond the hardened set (real helm)",
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), "dep-helm-"));
      try {
        mkdirSync(path.join(dir, "templates"));
        writeFileSync(path.join(dir, "Chart.yaml"), "apiVersion: v2\nname: d\nversion: 0.0.0\n");
        writeFileSync(
          path.join(dir, "values.yaml"),
          renderValuesYaml({
            pools: poolsMap({ memoryLimit: "512Mi" }),
            buildId: "b1",
            nextVersion: "16.2.0",
            config,
            imageRegistry: "us-docker.pkg.dev/p/r",
          }),
        );
        writeFileSync(
          path.join(dir, "templates", "ssr-deployment.yaml"),
          renderDeployment({ poolName: "ssr", buildId: "b1", releaseName: "my-app" }),
        );
        const out = execFileSync("helm", ["template", "d", dir], { encoding: "utf8" });
        // The hardening block above the container list must not be defeated by an
        // injected sibling key.
        expect(out).not.toContain("hostNetwork");
        expect(out).not.toContain("shareProcessNamespace");
        expect(out).toContain('memory: "512Mi"');
        // helm resolved the values into quoted scalars (it does no escaping of its own —
        // the quoting and the charset guard are what make that safe).
        expect(out).toContain('cpu: "250m"');
        expect(out).toContain("replicas: 1");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("renderDeployment rollout safety (N63, the other half of the 502/503 fix)", () => {
  it("never dips below the live replica count during a roll", () => {
    const yaml = renderDeployment({ poolName: "ssr", buildId: "b1", releaseName: "my-app" });
    // Any ordinary pool rollout must preserve available capacity; the default 25%/25% can
    // dip below the live count for small pools.
    expect(yaml).toMatch(
      /strategy:\n\s+type: RollingUpdate\n\s+rollingUpdate:\n\s+maxUnavailable: 0\n\s+maxSurge: 1/,
    );
    expect(yaml).toContain("minReadySeconds: 30");
  });
});
