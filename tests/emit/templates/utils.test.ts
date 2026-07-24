import { describe, it, expect } from "vitest";
import {
  sanitizeK8sName,
  assertSafeReleaseName,
  assertSafeProjectId,
  assertSafeRegion,
  routingManifestSnapshotName,
  composedBuildResourceNames,
  findBuildIdNameCollision,
  poolResourceNames,
  K8S_NAMESPACE,
} from "../../../src/emit/templates/utils.js";
// The snapshot name must be importable from its historical home too — deploy.ts and
// rollback.ts import it from routing-manifest-configmap.ts (re-export).
import { routingManifestSnapshotName as reExportedSnapshotName } from "../../../src/emit/templates/routing-manifest-configmap.js";
import { renderHPA } from "../../../src/emit/templates/hpa.js";
import { renderService } from "../../../src/emit/templates/service.js";

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
    expect(/-$/.test(result)).toBe(false);
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
    const [serviceDoc, hcpDoc] = renderService({ poolName, buildId, releaseName }).split("---");
    expect(names.hpa).toBe(metadataName(hpaDoc));
    expect(names.deployment).toBe(metadataName(serviceDoc!));
    expect(names.hcp).toBe(metadataName(hcpDoc!));

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
