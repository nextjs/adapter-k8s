import { describe, it, expect } from "vitest";
import {
  assertProbePathsUnowned,
  sanitizeK8sName,
  assertSafeReleaseName,
  assertSafeProjectId,
  assertSafeRegion,
  routingManifestSnapshotName,
  composedBuildResourceNames,
  findBuildIdNameCollision,
  findEmittedNameCollision,
  poolResourceNames,
  assertSafeQuantity,
  assertSafeReplicaCount,
  assertSafeTargetCPU,
  assertSafePoolName,
  assertSafeYamlScalar,
  assertSafeImageReference,
  K8S_NAMESPACE,
} from "../../../src/emit/templates/utils.js";
// The snapshot name must be importable from its historical home too — deploy.ts and
// rollback.ts import it from routing-manifest-configmap.ts (re-export).
import { routingManifestSnapshotName as reExportedSnapshotName } from "../../../src/emit/templates/routing-manifest-configmap.js";
import { renderHPA } from "../../../src/emit/templates/hpa.js";
import { renderService, renderActiveService } from "../../../src/emit/templates/service.js";

describe("sanitizeK8sName", () => {
  it("never emits a name ending in a hyphen when truncation lands on one", () => {
    // 62 'a's + '-' + 10 'z's = 73 chars. Truncating to 63 lands exactly on the hyphen.
    const input = "a".repeat(62) + "-" + "z".repeat(10);
    const result = sanitizeK8sName(input);
    expect(result.length).toBeLessThanOrEqual(63);
    expect(result.endsWith("-")).toBe(false);
    expect(/[a-z0-9]$/.test(result)).toBe(true);
    expect(/^[a-z]/.test(result)).toBe(true);
  });

  it("strips trailing hyphens introduced by the 63-char boundary", () => {
    const result = sanitizeK8sName("valid-name-" + "x".repeat(60) + "-suffix");
    expect(result.length).toBeLessThanOrEqual(63);
    expect(result.endsWith('-')).toBe(false);
  });

  it("handles all-special-character input", () => {
    const result = sanitizeK8sName("!!!@@@###");
    expect(result.length).toBeGreaterThan(0);
    expect(/^[a-z]/.test(result)).toBe(true);
    expect(/[a-z0-9]$/.test(result)).toBe(true);
    expect(result.endsWith("-")).toBe(false);
  });

  it("handles empty input", () => {
    const result = sanitizeK8sName("");
    expect(result.length).toBeGreaterThan(0);
    expect(/^[a-z]/.test(result)).toBe(true);
    expect(/[a-z0-9]$/.test(result)).toBe(true);
  });

  it("prepends a letter when the name starts with a digit", () => {
    const result = sanitizeK8sName("123abc");
    expect(/^[a-z]/.test(result)).toBe(true);
    expect(result).toContain("123abc");
  });

  it("produces the `b-` prefixed version label the blue/green cutover depends on", () => {
    // REGRESSION: the deploy.ts cutover patches the active Service's
    // app.kubernetes.io/version selector to sanitizeK8sName(buildId), and pods carry
    // the same value as their label. A build id starting with a digit MUST get the
    // `b-` prefix in BOTH places — a cutover copy that omitted it selected zero pods,
    // draining the Service to no endpoints and 503'ing the site. Pin the exact value.
    expect(sanitizeK8sName("7s_BTPTfkofoG2MRK25lK")).toBe("b-7s-btptfkofog2mrk25lk");
  });

  it("passes through a normal name unchanged", () => {
    expect(sanitizeK8sName("nextjs-ssr")).toBe("nextjs-ssr");
  });

  it("reserves room for a caller-appended suffix inside the 63-char limit", () => {
    // HPA/HCP names are <deployment>-hpa / <service>-hcp — truncating the base to
    // 63 first and appending after emitted 67-char names the API server rejects.
    const longBase = "a".repeat(70) + "-" + "b".repeat(20);
    const hpa = sanitizeK8sName(longBase, "-hpa");
    expect(hpa.length).toBeLessThanOrEqual(63);
    expect(hpa.endsWith("-hpa")).toBe(true);
    expect(hpa).not.toMatch(/--/);
    // The base portion is hyphen-stripped before the suffix is appended.
    expect(hpa.slice(0, -4).endsWith("-")).toBe(false);
    // Short names are untouched apart from the suffix.
    expect(sanitizeK8sName("nextjs-ssr", "-hcp")).toBe("nextjs-ssr-hcp");
  });
});

describe("routingManifestSnapshotName", () => {
  const DNS_1123 = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

  it("keeps date-style build ids distinct under a maximum-length release name", () => {
    // The old fixed `-routing-manifest-` infix left ~5 build-id chars under a 40-char
    // release — two date-style build ids collided and rollback mounted the WRONG
    // build's manifest. The trailing 8-hex digest of the FULL build id must survive
    // truncation and keep them distinct.
    const releaseName = "a".repeat(40);
    const a = routingManifestSnapshotName(releaseName, "2026-07-22-10-00-00");
    const b = routingManifestSnapshotName(releaseName, "2026-07-22-11-30-45");
    expect(a).not.toBe(b);
    for (const name of [a, b]) {
      expect(name.length).toBeLessThanOrEqual(63);
      expect(name).toMatch(DNS_1123);
      // The collision-proof digest sits at the END where truncation can't eat it.
      expect(name).toMatch(/-[0-9a-f]{8}$/);
    }
  });

  it("stays DNS-valid and <= 63 chars for awkward build ids", () => {
    const name = routingManifestSnapshotName("my-app", "Feature/Branch_X.Y");
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(DNS_1123);
  });

  it("is re-exported unchanged from routing-manifest-configmap.ts (deploy/rollback import path)", () => {
    expect(reExportedSnapshotName).toBe(routingManifestSnapshotName);
  });
});

describe("poolResourceNames (single source of truth for template-rendered names)", () => {
  // Extract metadata.name from a rendered manifest document. The first `name:` in each
  // document is metadata.name for every template exercised here.
  const metadataName = (doc: string) => doc.match(/^\s*name: (\S+)/m)![1];

  it("matches the rendered Deployment/HPA/HCP names for short bases", () => {
    const names = poolResourceNames("my-app", "ssr", "build-1");
    expect(names.deployment).toBe("my-app-ssr-build-1");
    expect(names.hpa).toBe("my-app-ssr-build-1-hpa");
    expect(names.hcp).toBe("my-app-ssr-build-1-hcp");
  });

  it("matches renderHPA/renderService EXACTLY when the composed base exceeds the 59-char suffix boundary", () => {
    // 30-char release + "-ssr-" + 30-char build id = a 65-char base: the deployment
    // name truncates at 63, the -hpa/-hcp variants at 59. Concatenating "-hpa" onto
    // the 63-truncated deployment name here yields a DIFFERENT (and invalid, 67-char)
    // name — the divergence behind the rollback-missed-HPA / deploy-rescale bug.
    const releaseName = "r".repeat(30);
    const poolName = "ssr";
    const buildId = "buildm" + "x".repeat(24);
    const names = poolResourceNames(releaseName, poolName, buildId);

    const hpaDoc = renderHPA({ poolName, buildId, releaseName });
    const serviceDoc = renderService({ poolName, buildId, releaseName });
    expect(names.hpa).toBe(metadataName(hpaDoc));
    expect(names.deployment).toBe(metadataName(serviceDoc));
    // N75: the VERSIONED Service no longer carries a HealthCheckPolicy (it could never
    // attach — no Gateway references that Service, so it has no backend service). The
    // stable per-pool policy from renderActiveService is the one that governs. The `-hcp`
    // name helper stays: deploy/rollback still clean up policies older builds created, and
    // it must keep reproducing the 59-char truncation boundary exactly.
    expect(serviceDoc).not.toContain("kind: HealthCheckPolicy");
    const [, activeHcpDoc, activePdbDoc] = renderActiveService({ poolName, releaseName }).split(
      "---",
    );
    expect(activeHcpDoc).toContain("kind: HealthCheckPolicy");
    expect(metadataName(activeHcpDoc!)).toBe(sanitizeK8sName(`${releaseName}-${poolName}`, "-hcp"));
    expect(activePdbDoc).toContain("kind: PodDisruptionBudget");
    expect(names.hcp.length).toBeLessThanOrEqual(63);

    // The naive CLI reconstruction diverges — that is exactly what the helper prevents.
    expect(`${names.deployment}-hpa`).not.toBe(names.hpa);
    expect(`${names.deployment}-hpa`.length).toBeGreaterThan(63);
    expect(names.hpa.length).toBeLessThanOrEqual(63);
    expect(names.hcp.length).toBeLessThanOrEqual(63);
  });

  it("re-sanitizing a truncated deployment name with a suffix reproduces the template's suffixed name", () => {
    // deploy.ts's old-build cleanup only has the cluster-listed (63-truncated)
    // deployment name; it derives the HCP name via sanitizeK8sName(name, "-hcp").
    // That must equal what the template rendered from the RAW base.
    const base = `${"r".repeat(30)}-ssr-buildm${"x".repeat(24)}`;
    const deployment = sanitizeK8sName(base);
    expect(sanitizeK8sName(deployment, "-hcp")).toBe(sanitizeK8sName(base, "-hcp"));
    // Also when truncation lands in a hyphen run.
    const hyphenBase = `${"a".repeat(57)}-${"b".repeat(10)}`;
    expect(sanitizeK8sName(sanitizeK8sName(hyphenBase), "-hcp")).toBe(
      sanitizeK8sName(hyphenBase, "-hcp"),
    );
  });
});

describe("K8S_NAMESPACE", () => {
  it("is pinned to the namespace init binds Workload Identity to", () => {
    // deploy/rollback/state/destroy/doctor/describe all pin this literal; the
    // build-time and deploy-time guards reject anything else in infrastructure.json.
    expect(K8S_NAMESPACE).toBe("default");
  });
});

describe("findBuildIdNameCollision (composed blue/green resource names)", () => {
  it("fires when a max-length release+pool truncates the build id away entirely", () => {
    // 40-char release + 40-char pool = an 82-char `release-pool-` prefix: the entire
    // build id is truncated out of the 63-char name, so ANY two builds collide.
    // Comparing sanitizeK8sName(buildId) alone (the old guard) missed this.
    const releaseName = "r".repeat(40);
    const poolName = "p".repeat(40);
    const collision = findBuildIdNameCollision(
      releaseName,
      [poolName],
      "2026072210000-aaaa",
      "2026072210000-bbbb",
    );
    expect(collision).not.toBeNull();
    expect(collision!.name).toBe(sanitizeK8sName(`${releaseName}-${poolName}-2026072210000-aaaa`));
    expect(collision!.kind).toBe("Deployment/Service");
  });

  it("fires when only the -hpa/-hcp variants (59-char cap) collide", () => {
    // Prefix sized so the base 63-char names keep 8 distinguishing build-id chars but
    // the -hpa/-hcp variants (truncated 4 chars earlier) keep only the shared 4.
    const releaseName = "r".repeat(40);
    const poolName = "p".repeat(13); // "r"*40 + "-" + "p"*13 + "-" = 55-char prefix
    const a = "aaaabbbb";
    const b = "aaaacccc";
    // Base names differ...
    expect(sanitizeK8sName(`${releaseName}-${poolName}-${a}`)).not.toBe(
      sanitizeK8sName(`${releaseName}-${poolName}-${b}`),
    );
    // ...but the guard still fires on the suffix variants — hpa-vs-hpa is a genuine
    // same-kind collision, and the kind is reported for the error message.
    const collision = findBuildIdNameCollision(releaseName, [poolName], a, b);
    expect(collision).toEqual({
      kind: "HorizontalPodAutoscaler",
      name: sanitizeK8sName(`${releaseName}-${poolName}-${a}`, "-hpa"),
    });
  });

  it("fires when build ids differ only in sanitized-away characters", () => {
    expect(findBuildIdNameCollision("my-app", ["ssr"], "abc_def", "abc-def")).not.toBeNull();
  });

  it("does not false-positive on normal-length names with distinct build ids", () => {
    expect(
      findBuildIdNameCollision("my-app", ["ssr", "api"], "7s-btptfkofog2mrk25lk", "b12345"),
    ).toBeNull();
  });

  it('does NOT false-positive across kinds: build ids "foo" and "foo-hpa" coexist', () => {
    // Build "foo"'s HPA is named my-app-ssr-foo-hpa — the same STRING as build
    // "foo-hpa"'s Deployment. K8s uniqueness is per kind, so a Deployment and an HPA
    // sharing a name is fine; the old flat cross-kind set rejected this deploy.
    expect(findBuildIdNameCollision("my-app", ["ssr"], "foo", "foo-hpa")).toBeNull();
    expect(findBuildIdNameCollision("my-app", ["ssr"], "foo-hpa", "foo")).toBeNull();
    // Same shape for the hcp suffix.
    expect(findBuildIdNameCollision("my-app", ["ssr"], "foo", "foo-hcp")).toBeNull();
  });

  it("still fires on genuine same-kind collisions across pools", () => {
    // A 40-char release truncates two long pool names to the same prefix: pool A's
    // Deployment (current build) collides with pool B's Deployment (previous build)
    // even though the build ids differ — same kind, real collision.
    const releaseName = "r".repeat(40);
    const poolA = "p".repeat(30) + "aa";
    const poolB = "p".repeat(30) + "bb";
    const collision = findBuildIdNameCollision(releaseName, [poolA, poolB], "build1", "build2");
    expect(collision).not.toBeNull();
    expect(collision!.kind).toBe("Deployment/Service");
  });

  it("includes the routing-manifest snapshot ConfigMap in the composed-name set", () => {
    const names = composedBuildResourceNames("my-app", ["ssr"], "build-1");
    expect(names).toContain(routingManifestSnapshotName("my-app", "build-1"));
    // Per pool: base + -hpa + -hcp, plus the snapshot name.
    expect(names).toHaveLength(4);
  });
});

describe("assertSafeReleaseName", () => {
  it("accepts safe release names", () => {
    expect(() => assertSafeReleaseName("nextjs")).not.toThrow();
    expect(() => assertSafeReleaseName("my-app-1")).not.toThrow();
  });

  it("rejects release names with shell metacharacters", () => {
    expect(() => assertSafeReleaseName('foo";rm -rf /;"')).toThrow(/Invalid releaseName/);
    expect(() => assertSafeReleaseName("foo$(whoami)")).toThrow(/Invalid releaseName/);
    expect(() => assertSafeReleaseName("Upper")).toThrow(/Invalid releaseName/);
  });
});

describe("assertSafeProjectId", () => {
  it("accepts valid GCP project ids", () => {
    expect(() => assertSafeProjectId("my-project")).not.toThrow();
    expect(() => assertSafeProjectId("proj123")).not.toThrow();
  });

  it("rejects project ids with injection payloads", () => {
    expect(() => assertSafeProjectId('a";curl evil"')).toThrow(/Invalid projectId/);
    expect(() => assertSafeProjectId("bad")).toThrow(/Invalid projectId/); // too short
  });
});

describe("assertSafeRegion", () => {
  it("accepts valid regions", () => {
    expect(() => assertSafeRegion("us-central1")).not.toThrow();
  });

  it("rejects regions with metacharacters", () => {
    expect(() => assertSafeRegion("us-central1;reboot")).toThrow(/Invalid region/);
  });
});

// ---------------------------------------------------------------------------
// N60 — quantity / integer validators (the two findings where NO validator existed).
// ---------------------------------------------------------------------------
describe("assertSafeQuantity", () => {
  it("accepts the quantity forms a pod spec needs", () => {
    for (const q of ["1", "0", "1.5", "250m", "100m", "512Mi", "2Gi", "64Ki", "1000", "5T", "2P"]) {
      expect(() => assertSafeQuantity(q, "x")).not.toThrow();
    }
  });

  it("rejects the verified pod-spec injection payloads", () => {
    // The values.yaml -> helm sink (deployment.ts). Rendered `hostNetwork: true` on the POD
    // before this validator existed, voiding both NetworkPolicy postures (N19).
    expect(() =>
      assertSafeQuantity(
        '512Mi"\n      hostNetwork: true\n      shareProcessNamespace: true\n      _pad: "',
        "pool resources.memoryLimit",
      ),
    ).toThrow(/Invalid Kubernetes quantity/);
    // The UNQUOTED routing-tier sink (routing-service-deployment.ts) — needed no escaping
    // at all; this injected a sibling key on the first try.
    expect(() =>
      assertSafeQuantity("250m\n              INJECTED: yes", "routingService.resources.cpu"),
    ).toThrow(/Invalid Kubernetes quantity/);
  });

  it("rejects near-miss forms outside the deliberate subset", () => {
    for (const q of ["", " 1", "1 ", "1e3", "-1", "1.2.3", "512MiB", "$(id)", "1;reboot", "abc"]) {
      expect(() => assertSafeQuantity(q, "x")).toThrow(/Invalid Kubernetes quantity/);
    }
    expect(() => assertSafeQuantity(512 as unknown as string, "x")).toThrow(
      /Invalid Kubernetes quantity/,
    );
  });

  it("names the offending field in the error (operator-actionable)", () => {
    expect(() => assertSafeQuantity("nope", 'pool "ssr" resources.cpu')).toThrow(
      /pool "ssr" resources\.cpu/,
    );
  });
});

describe("assertSafeReplicaCount / assertSafeTargetCPU", () => {
  it("require real integers in range", () => {
    expect(() => assertSafeReplicaCount(0, "min")).not.toThrow();
    expect(() => assertSafeReplicaCount(6, "min")).not.toThrow();
    expect(() => assertSafeReplicaCount(-1, "min")).toThrow(/Invalid min/);
    expect(() => assertSafeReplicaCount(1.5, "min")).toThrow(/Invalid min/);
    expect(() => assertSafeReplicaCount("1\n  INJECTED: yes" as unknown as number, "min")).toThrow(
      /Invalid min/,
    );
    expect(() => assertSafeReplicaCount(NaN, "min")).toThrow(/Invalid min/);

    expect(() => assertSafeTargetCPU(70, "t")).not.toThrow();
    expect(() => assertSafeTargetCPU(0, "t")).toThrow(/Invalid t/);
    // HPA averageUtilization is a percentage of REQUESTED cpu, so >100 is valid and common
    // (request 250m, run happily at 500m → 200). The old cap rejected working configs.
    expect(() => assertSafeTargetCPU(101, "t")).not.toThrow();
    expect(() => assertSafeTargetCPU(200, "t")).not.toThrow();
    expect(() => assertSafeTargetCPU(10_001, "t")).toThrow(/Invalid t/);
  });
});

describe("assertSafePoolName (N61)", () => {
  it("accepts normal pool names", () => {
    for (const n of ["ssr", "api", "api-v2", "a", "p0", "on", "true", "123"]) {
      expect(() => assertSafePoolName(n)).not.toThrow();
    }
  });

  it("rejects edge hyphens (invalid label value / DNS-1123 component)", () => {
    // The old /^[a-z0-9-]+$/ admitted all of these.
    for (const n of ["-api", "api-", "-", "--"]) {
      expect(() => assertSafePoolName(n)).toThrow(/Invalid pool name/);
    }
  });

  it("rejects uppercase, dots, and injection payloads", () => {
    for (const n of ["API", "a.b", "a b", 'x"\n  y: z', "a/b", ""]) {
      expect(() => assertSafePoolName(n)).toThrow(/Invalid pool name/);
    }
  });

  it("leaves the 40-char name-budget message to validateConfig (this cap is the label ceiling)", () => {
    expect(() => assertSafePoolName("a".repeat(41))).not.toThrow();
    expect(() => assertSafePoolName("a".repeat(64))).toThrow(/Invalid pool name/);
  });
});

describe("assertSafeYamlScalar (N67)", () => {
  it("accepts the values extension-chain.ts generates", () => {
    expect(() =>
      assertSafeYamlScalar("my-app-routing-service.default.svc.cluster.local", "authority"),
    ).not.toThrow();
    expect(() =>
      assertSafeYamlScalar("projects/p/global/backendServices/my-app-routing-service", "service"),
    ).not.toThrow();
  });

  it("rejects a scalar breakout, a backslash, and control characters", () => {
    expect(() => assertSafeYamlScalar('a"\n  failOpen: true', "authority")).toThrow(/Unsafe/);
    expect(() => assertSafeYamlScalar("a\\b", "service")).toThrow(/Unsafe/);
    expect(() => assertSafeYamlScalar(5 as unknown as string, "service")).toThrow(/Invalid/);
  });
});

describe("assertSafeImageReference (N66)", () => {
  it("accepts a registry/repo:tag and a digest form", () => {
    expect(() =>
      assertSafeImageReference("us-central1-docker.pkg.dev/p/r/nextjs-app-ssr:build1"),
    ).not.toThrow();
    expect(() =>
      assertSafeImageReference(`reg.example.com/p/app@sha256:${"a".repeat(64)}`),
    ).not.toThrow();
    expect(() => assertSafeImageReference("localhost:5000/app:v1")).not.toThrow();
  });

  it("rejects a scheme, a quote breakout, and whitespace", () => {
    expect(() => assertSafeImageReference("https://reg/app:v1")).toThrow(/Invalid image reference/);
    expect(() => assertSafeImageReference('reg/app:v1"\n  hostNetwork: true')).toThrow(
      /Invalid image reference/,
    );
    expect(() => assertSafeImageReference("reg/app :v1")).toThrow(/Invalid image reference/);
  });
});

describe("findEmittedNameCollision (N62: the FULL emitted-name set)", () => {
  it("covers the stable per-pool names, not just the versioned ones", () => {
    // The old guard compared current-vs-previous per pool ONLY, so it never looked at a
    // versioned name against another pool's stable (active) name.
    expect(findEmittedNameCollision("nextjs", ["api", "api-v2"], ["v2"])).toEqual({
      kind: "Deployment/Service",
      name: "nextjs-api-v2",
    });
    // Same shape for the HealthCheckPolicy namespace when only the -hcp variants collide.
    const releaseName = "r".repeat(40);
    const hcpOnly = findEmittedNameCollision(
      releaseName,
      ["p".repeat(13)],
      ["aaaabbbb", "aaaacccc"],
    );
    expect(hcpOnly).not.toBeNull();
  });

  it("keeps kinds separate (a Deployment and an HPA may share a name)", () => {
    expect(findEmittedNameCollision("my-app", ["ssr"], ["foo", "foo-hpa"])).toBeNull();
    expect(findEmittedNameCollision("my-app", ["ssr"], ["foo", "foo-hcp"])).toBeNull();
  });

  it("reports a build id that sanitizes into the routing tier's own name", () => {
    expect(findEmittedNameCollision("nextjs", ["routing"], ["service"])).toEqual({
      kind: "Deployment/Service",
      name: "nextjs-routing-service",
    });
    // The same pair also collides in the HPA namespace (nextjs-routing-service-hpa), but
    // the Deployment/Service bucket is checked first, which is the more actionable message.
  });

  it("is clean for a realistic release", () => {
    expect(
      findEmittedNameCollision("nextjs", ["ssr", "api", "static"], ["b12345", "b67890"]),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// S17 — a release name that is a YAML 1.1 boolean must not render a bare scalar.
// N61 fixed this for the POOL name at every label/selector; the release name stayed bare, and
// the API server rejects the manifest with "cannot unmarshal bool into … metadata.labels".
// ---------------------------------------------------------------------------
describe("S17: release names that are YAML booleans", () => {
  it("renders quoted in every template that stamps the name label", async () => {
    const { renderDeployment } = await import("../../../src/emit/templates/deployment.js");
    const { renderService, renderActiveService } =
      await import("../../../src/emit/templates/service.js");
    const { renderNetworkPolicies } = await import("../../../src/emit/templates/network-policy.js");
    for (const releaseName of ["on", "no", "y"]) {
      const rendered = [
        renderDeployment({ poolName: "ssr", buildId: "b1", releaseName }),
        renderService({ poolName: "ssr", buildId: "b1", releaseName }),
        renderActiveService({ poolName: "ssr", releaseName }),
        renderNetworkPolicies({ releaseName, poolNames: ["ssr"] }),
      ].join("\n");
      expect(rendered).not.toMatch(/app\.kubernetes\.io\/name: (on|no|y|true|false)\s*$/m);
      expect(rendered).toContain(`app.kubernetes.io/name: "${releaseName}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// The platform probe paths belong to the platform. The pool server declines to shadow an app
// that owns /healthz or /readyz (so the route is not silently swallowed), but at runtime those
// paths ARE the pod's verdict for the kubelet, the Gateway HealthCheckPolicy and the blue/green
// cutover gate — so a static 200 at /readyz promotes a pod whose instrumentation threw (the
// exact failure /readyz exists to catch), and an authenticated route there keeps a healthy pod
// unready forever. Fail the build instead, where the message can say what to rename.
// ---------------------------------------------------------------------------
describe("assertProbePathsUnowned", () => {
  const clean = {
    pathnames: ["/", "/blog/[slug]", "/api/health"],
    staticPathnames: ["/_next/static/chunk.js"],
    publicPathnames: ["/favicon.ico", "/health.txt"],
  };

  it("passes for an app that owns neither probe path", () => {
    expect(() => assertProbePathsUnowned(clean)).not.toThrow();
  });

  it("rejects an app ROUTE at either probe path", () => {
    expect(() =>
      assertProbePathsUnowned({ ...clean, pathnames: [...clean.pathnames, "/readyz"] }),
    ).toThrow(/reserved platform probe path.*\/readyz/s);
    expect(() =>
      assertProbePathsUnowned({ ...clean, pathnames: [...clean.pathnames, "/healthz"] }),
    ).toThrow(/\/healthz/);
  });

  it("rejects a PUBLIC file too — a static 200 is the dangerous case", () => {
    expect(() =>
      assertProbePathsUnowned({ ...clean, publicPathnames: [...clean.publicPathnames, "/readyz"] }),
    ).toThrow(/public\/ file/);
  });

  it("rejects a static OUTPUT at a probe path", () => {
    expect(() => assertProbePathsUnowned({ ...clean, staticPathnames: ["/readyz"] })).toThrow(
      /static output/,
    );
  });

  it("compares the basePath-stripped form — probes target the pod, without the basePath", () => {
    expect(() =>
      assertProbePathsUnowned({ ...clean, pathnames: ["/docs/readyz"], basePath: "/docs" }),
    ).toThrow(/\/readyz/);
    // …and a path that only LOOKS like one under a different prefix is fine.
    expect(() =>
      assertProbePathsUnowned({ ...clean, pathnames: ["/other/readyz"], basePath: "/docs" }),
    ).not.toThrow();
  });

  it("names every collision, so one build failure fixes both", () => {
    expect(() =>
      assertProbePathsUnowned({ ...clean, pathnames: ["/healthz"], publicPathnames: ["/readyz"] }),
    ).toThrow(/\/healthz.*\/readyz|\/readyz.*\/healthz/s);
  });
});
