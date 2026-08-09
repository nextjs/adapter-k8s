import { describe, it, expect } from "vitest";
import {
  renderRouteExtUpdateJob,
  routeExtJobName,
} from "../../../src/emit/templates/route-ext-update-job.js";
import {
  renderRouteExtConfigMap,
  routeExtDocumentDigest,
} from "../../../src/emit/templates/route-ext-configmap.js";

// A minimal, valid extension chain — the same shape extension-chain.ts generates.
const MINIMAL_CHAIN_JSON = JSON.stringify(
  [
    {
      name: "nextjs-routing",
      matchCondition: { celExpression: "true" },
      extensions: [
        {
          name: "routing-service",
          authority: "my-app-routing-service.default.svc.cluster.local",
          service: "projects/p-123456/global/backendServices/my-app-routing-service",
          timeout: "5s",
          supportedEvents: ["REQUEST_HEADERS"],
          failOpen: true,
        },
      ],
    },
  ],
  null,
  2,
);

describe("renderRouteExtUpdateJob", () => {
  it("renders a Helm hook Job using import command", () => {
    const yaml = renderRouteExtUpdateJob({
      releaseName: "my-app",
      projectId: "my-project",
      region: "us-central1",
      buildId: "abc123",
    });
    expect(yaml).toContain("kind: Job");
    // Not a Helm hook — runs as a regular Job so it doesn't block deploys
    expect(yaml).toContain("kind: Job");
    expect(yaml).toContain("gcloud service-extensions lb-traffic-extensions import");
    expect(yaml).toContain("my-app-traffic-ext");
    expect(yaml).toContain("route-extension.yaml");
    // Attaches the standalone routing NEG to the ext_proc backend service
    expect(yaml).toContain("my-app-routing-neg");
    expect(yaml).toContain("add-backend");
    expect(yaml).toContain(
      "gcr.io/google.com/cloudsdktool/google-cloud-cli@sha256:6fd292185f0efc136eff2f6d20287870e5b66619818d5108c31ad55311722028",
    );
    expect(yaml).toContain('kubernetes.io/arch: "{{ .Values.global.targetArchitecture }}"');
  });

  it("renders the exact job name from routeExtJobName (deploy cleanup matches this)", () => {
    const buildId = "jpY1GCvqshOHB9PiQlgyf";
    const name = routeExtJobName("my-app", buildId);
    const yaml = renderRouteExtUpdateJob({
      releaseName: "my-app",
      projectId: "my-project",
      region: "us-central1",
      buildId,
    });
    // The rendered Job name MUST equal routeExtJobName's output — deploy.ts skips the
    // current job by exact name, and any drift deletes the running job mid-registration.
    expect(yaml).toContain(`name: ${name}`);
    // A fixed digest of the complete build id keeps immutable Job names collision-resistant
    // without risking truncation beyond Kubernetes' 63-character name limit.
    expect(name).toBe("my-app-route-ext-ca7026fd6961");
    expect(name.length).toBeLessThanOrEqual(63);
    // The digested name no longer reveals the build — the annotation records the full id
    // so operators can map a Job back to its build.
    expect(yaml).toContain(`adapter-k8s.dev/build-id: "${buildId}"`);
  });

  it("produces collision-resistant, DNS-safe job names for awkward build ids", () => {
    // A maximum-length release leaves only 12 build-id characters in the old truncated
    // name. The digest must still distinguish full build ids that share that prefix.
    const releaseName = "a".repeat(40);
    const a = routeExtJobName(releaseName, "aaaaaaaaaaaabbbb");
    const b = routeExtJobName(releaseName, "aaaaaaaaaaaacccc");
    expect(a).not.toBe(b);
    expect(a).toHaveLength(63);
    // The digest result is DNS-safe and fits the Kubernetes name limit.
    const c = routeExtJobName("my-app", "Feature/Branch_X.Y");
    expect(c).toMatch(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/);
  });

  it("pins the cloud-sdk image by immutable digest (mutable :slim tag must not return)", () => {
    // The Job runs gcloud under a privileged Workload-Identity SA — a mutable tag lets
    // a registry-side tag move change what executes with those permissions.
    const yaml = renderRouteExtUpdateJob({
      releaseName: "my-app",
      projectId: "my-project",
      region: "us-central1",
      buildId: "abc123",
    });
    expect(yaml).toMatch(/google-cloud-cli@sha256:[0-9a-f]{64}/);
  });

  it("ships the hardened job/pod posture (ttl, non-root, read-only FS, gcloud config home)", () => {
    const yaml = renderRouteExtUpdateJob({
      releaseName: "my-app",
      projectId: "my-project",
      region: "us-central1",
      buildId: "abc123",
    });
    // Finished Jobs are swept after an hour.
    expect(yaml).toContain("ttlSecondsAfterFinished: 3600");
    // Pod runs as nobody (65534) with seccomp.
    expect(yaml).toContain("runAsNonRoot: true");
    expect(yaml).toContain("runAsUser: 65534");
    expect(yaml).toContain("fsGroup: 65534");
    expect(yaml).toContain("seccompProfile:");
    expect(yaml).toContain("type: RuntimeDefault");
    // Container: no privilege escalation, read-only root FS, all caps dropped.
    expect(yaml).toContain("allowPrivilegeEscalation: false");
    expect(yaml).toContain("readOnlyRootFilesystem: true");
    expect(yaml).toContain('drop: ["ALL"]');
    // gcloud needs a writable config home as non-root; /tmp is an emptyDir.
    expect(yaml).toMatch(/- name: CLOUDSDK_CONFIG\n\s+value: \/tmp\/\.config\/gcloud/);
    expect(yaml).toMatch(/volumeMounts:[\s\S]*?name: tmp\n\s+mountPath: \/tmp/);
    expect(yaml).toMatch(/volumes:[\s\S]*?name: tmp\n\s+emptyDir: \{\}/);
  });

  it("keeps the Workload Identity SA automounted (no automountServiceAccountToken: false)", () => {
    const yaml = renderRouteExtUpdateJob({
      releaseName: "my-app",
      projectId: "my-project",
      region: "us-central1",
      buildId: "abc123",
    });
    // The Job needs its SA token to call gcloud via Workload Identity — unlike the app
    // workloads, automountServiceAccountToken must NOT be disabled here.
    expect(yaml).toContain("serviceAccountName: my-app-deploy-sa");
    expect(yaml).not.toContain("automountServiceAccountToken: false");
  });

  it("attaches to ALL forwarding rules and fails loudly (no http:// bypass, no false success)", () => {
    const yaml = renderRouteExtUpdateJob({
      releaseName: "my-app",
      projectId: "my-project",
      region: "us-central1",
      buildId: "abc123",
    });
    // P1: must NOT select a single/HTTPS-only forwarding rule — that leaves http:// traffic
    // bypassing the extension (middleware auth/rewrite bypass). Expand every FR.
    expect(yaml).not.toContain("--limit=1");
    expect(yaml).not.toContain("targetHttpsProxies");
    expect(yaml).toContain("FORWARDING_RULE_PLACEHOLDER");
    expect(yaml).toContain("fr_list");
    // P2: fail loudly (exit 1) when FR/NEG are absent — never silently "succeed" unregistered.
    expect(yaml).toContain("exit 1");
    expect(yaml).not.toContain("Skipping traffic extension");
    expect(yaml).toContain("only ${ATTACHED:-0}/$ZC zonal NEG(s) attached");
  });

  it("rejects a releaseName containing shell metacharacters", () => {
    expect(() =>
      renderRouteExtUpdateJob({
        releaseName: 'foo";rm -rf /;"',
        projectId: "my-project",
        region: "us-central1",
        buildId: "abc123",
      }),
    ).toThrow(/Invalid releaseName/);
  });

  it("rejects a releaseName with a leading or trailing hyphen (invalid DNS-1123 prefix)", () => {
    for (const releaseName of ["-my-app", "my-app-"]) {
      expect(() =>
        renderRouteExtUpdateJob({
          releaseName,
          projectId: "my-project",
          region: "us-central1",
          buildId: "abc123",
        }),
      ).toThrow(/Invalid releaseName/);
    }
  });

  it("rejects a buildId outside the safe charset (interpolated into the annotation)", () => {
    expect(() =>
      renderRouteExtUpdateJob({
        releaseName: "my-app",
        projectId: "my-project",
        region: "us-central1",
        buildId: 'abc"123',
      }),
    ).toThrow(/Invalid buildId/);
  });

  it("rejects a projectId containing an injection payload", () => {
    expect(() =>
      renderRouteExtUpdateJob({
        releaseName: "my-app",
        projectId: 'p";curl evil"',
        region: "us-central1",
        buildId: "abc123",
      }),
    ).toThrow(/Invalid projectId/);
  });

  it("rejects a region containing shell metacharacters", () => {
    expect(() =>
      renderRouteExtUpdateJob({
        releaseName: "my-app",
        projectId: "my-project",
        region: "us-central1;reboot",
        buildId: "abc123",
      }),
    ).toThrow(/Invalid region/);
  });
});

describe("renderRouteExtConfigMap", () => {
  it("renders a ConfigMap with route extension YAML spec", () => {
    const chainJson = JSON.stringify([
      {
        name: "nextjs-routing",
        matchCondition: { celExpression: "true" },
        extensions: [
          {
            name: "routing-service",
            authority: "my-app-routing-service.default.svc.cluster.local",
            service:
              "projects/my-project/locations/us-central1/backendServices/my-app-routing-service",
            timeout: "5s",
            supportedEvents: ["REQUEST_HEADERS"],
            failOpen: true,
          },
        ],
      },
    ]);

    const yaml = renderRouteExtConfigMap({
      releaseName: "my-app",
      extensionChainJson: chainJson,
    });

    expect(yaml).toContain("kind: ConfigMap");
    expect(yaml).toContain("route-extension.yaml");
    expect(yaml).toContain("loadBalancingScheme: EXTERNAL_MANAGED");
    expect(yaml).toContain("my-app-traffic-ext");
    expect(yaml).toContain("nextjs-routing");
  });

  it("embeds the CEL expression as a YAML single-quoted scalar that round-trips", () => {
    // A public file with an apostrophe (o'brien.txt) makes the CEL text contain \'.
    // In a YAML DOUBLE-quoted scalar \' is an invalid escape — the produced
    // route-extension.yaml would be unparseable and the extension would never register.
    // Single-quoted YAML escapes ' by doubling, operating on the already-CEL-escaped
    // text, so the YAML parser reads the CEL text back exactly.
    const celExpression = "!(request.path == '/o\\'brien.txt')"; // CEL: /o\'brien.txt
    const chainJson = JSON.stringify([
      {
        name: "nextjs-routing",
        matchCondition: { celExpression },
        extensions: [
          {
            name: "routing-service",
            authority: "my-app-routing-service.default.svc.cluster.local",
            service:
              "projects/my-project/locations/us-central1/backendServices/my-app-routing-service",
            timeout: "5s",
            supportedEvents: ["REQUEST_HEADERS"],
            failOpen: true,
          },
        ],
      },
    ]);

    const yaml = renderRouteExtConfigMap({
      releaseName: "my-app",
      extensionChainJson: chainJson,
    });

    // The scalar must be single-quoted with only '' quote pairs inside (valid YAML).
    const match = yaml.match(/^ +celExpression: '((?:[^']|'')*)'$/m);
    expect(match).not.toBeNull();
    // Un-doubling the YAML escape must yield the exact CEL text (round-trip).
    expect(match![1].replace(/''/g, "'")).toBe(celExpression);
    // And the raw CEL quote sequence must not appear un-doubled.
    expect(yaml).not.toContain(`celExpression: "${celExpression}"`);
  });
});

// ---------------------------------------------------------------------------
// N67 (SECURITY) — failOpen must be explicit; the double-quoted scalars must be validated.
// ---------------------------------------------------------------------------
describe("N67: renderRouteExtConfigMap input validation", () => {
  const chain = (
    extOverrides: Record<string, unknown> = {},
    chainOverrides: Record<string, unknown> = {},
  ) =>
    JSON.stringify([
      {
        name: "nextjs-routing",
        matchCondition: { celExpression: "true" },
        ...chainOverrides,
        extensions: [
          {
            name: "routing-service",
            authority: "my-app-routing-service.default.svc.cluster.local",
            service: "projects/my-project/global/backendServices/my-app-routing-service",
            timeout: "5s",
            supportedEvents: ["REQUEST_HEADERS"],
            failOpen: false,
            ...extOverrides,
          },
        ],
      },
    ]);

  it("rejects a chain whose failOpen is ABSENT rather than defaulting it", () => {
    // `?? true` was the middleware-BYPASS direction, in the file that configures the
    // fail-CLOSED posture (invariant 2). generateExtensionChain always sets it, so the old
    // default only bit a hand-written / tampered / older extension-chains.json — precisely
    // the input this function JSON.parses and hands to a privileged `gcloud … import`.
    const json = JSON.parse(chain());
    delete json[0].extensions[0].failOpen;
    expect(() =>
      renderRouteExtConfigMap({ releaseName: "my-app", extensionChainJson: JSON.stringify(json) }),
    ).toThrow(/missing a boolean `failOpen`/);
  });

  it("rejects a non-boolean failOpen (a truthy string used to render as-is)", () => {
    expect(() =>
      renderRouteExtConfigMap({
        releaseName: "my-app",
        extensionChainJson: chain({ failOpen: "true" }),
      }),
    ).toThrow(/missing a boolean `failOpen`/);
  });

  it("emits the explicit policy verbatim in both directions", () => {
    expect(
      renderRouteExtConfigMap({ releaseName: "my-app", extensionChainJson: chain() }),
    ).toContain("failOpen: false");
    expect(
      renderRouteExtConfigMap({
        releaseName: "my-app",
        extensionChainJson: chain({ failOpen: true }),
      }),
    ).toContain("failOpen: true");
  });

  it("throws instead of silently discarding extra chains / extensions", () => {
    const two = JSON.parse(chain());
    two.push(JSON.parse(chain())[0]);
    expect(() =>
      renderRouteExtConfigMap({ releaseName: "my-app", extensionChainJson: JSON.stringify(two) }),
    ).toThrow(/exactly one chain/);

    const twoExt = JSON.parse(chain());
    twoExt[0].extensions.push({ ...twoExt[0].extensions[0], name: "second" });
    expect(() =>
      renderRouteExtConfigMap({
        releaseName: "my-app",
        extensionChainJson: JSON.stringify(twoExt),
      }),
    ).toThrow(/exactly one extension/);

    expect(() =>
      renderRouteExtConfigMap({ releaseName: "my-app", extensionChainJson: "[]" }),
    ).toThrow(/exactly one chain/);
  });

  it("validates releaseName (this file had no guard at all)", () => {
    expect(() =>
      renderRouteExtConfigMap({ releaseName: 'x"\nfoo: bar', extensionChainJson: chain() }),
    ).toThrow(/Invalid releaseName/);
  });

  it("rejects a scalar breakout in authority / service / timeout / chain name / extension name", () => {
    const payload = 'x"\n        failOpen: true\n        _pad: "';
    for (const field of ["authority", "service", "timeout", "name"] as const) {
      expect(() =>
        renderRouteExtConfigMap({
          releaseName: "my-app",
          extensionChainJson: chain({ [field]: payload }),
        }),
      ).toThrow(/Unsafe extension-chains\.json/);
    }
    expect(() =>
      renderRouteExtConfigMap({
        releaseName: "my-app",
        extensionChainJson: chain({}, { name: payload }),
      }),
    ).toThrow(/Unsafe extension-chains\.json chain name/);
  });

  it("rejects a forwardingRule that would break out of its quoted scalar", () => {
    expect(() =>
      renderRouteExtConfigMap({
        releaseName: "my-app",
        extensionChainJson: chain(),
        forwardingRule: 'fr"\nextensionChains: []',
      }),
    ).toThrow(/Unsafe forwardingRule/);
  });
});

// ---------------------------------------------------------------------------
// N73 (SECURITY) — the Job must verify the operator-mutable ConfigMap it imports.
// ---------------------------------------------------------------------------
describe("N73: route-ext Job verifies the mounted route-extension.yaml", () => {
  const job = () =>
    renderRouteExtUpdateJob({
      releaseName: "my-app",
      projectId: "my-project",
      region: "us-central1",
      buildId: "abc123",
    });

  it("pins the expected service and authority to the values it was RENDERED with", () => {
    const yaml = job();
    // Both are fully determined by release name + project + the Helm release namespace,
    // so they can be re-derived rather than trusted from /config.
    expect(yaml).toContain(
      'EXPECT_SERVICE="projects/my-project/global/backendServices/my-app-routing-service"',
    );
    expect(yaml).toContain(
      'EXPECT_AUTHORITY="my-app-routing-service.{{ .Release.Namespace }}.svc.cluster.local"',
    );
  });

  it("aborts before the privileged import when either value mismatches", () => {
    const yaml = job();
    const importIdx = yaml.indexOf("lb-traffic-extensions import");
    for (const guard of [
      'if [ "$GOT_SERVICE" != "$EXPECT_SERVICE" ]',
      'if [ "$GOT_AUTHORITY" != "$EXPECT_AUTHORITY" ]',
    ]) {
      const idx = yaml.indexOf(guard);
      expect(idx).toBeGreaterThan(-1);
      // The check must precede the import, or it verifies nothing.
      expect(idx).toBeLessThan(importIdx);
    }
    expect(yaml).toContain("Refusing to import");
    // …and the extension NAME must be this release's too.
    expect(yaml).toContain(`grep -q '^name: "my-app-traffic-ext"$' /tmp/ext.yaml`);
  });

  it("extracts the mounted values with a well-formed sed expression", () => {
    // The rendered script must contain single-backslash BRE groups (a double backslash here
    // would make sed match a literal backslash and the comparison would always fail-closed).
    expect(job()).toContain(`sed -n 's/^ *service: *"\\(.*\\)" *$/\\1/p' /tmp/ext.yaml`);
    expect(job()).toContain(`sed -n 's/^ *authority: *"\\(.*\\)" *$/\\1/p' /tmp/ext.yaml`);
  });
});

// ---------------------------------------------------------------------------
// S9 (SECURITY) — the Job pins the mounted document to the digest of what the chart rendered.
//
// N73 verified `service`, `authority` and `name` only, which left forwardingRules,
// celExpression, timeout, failOpen, supportedEvents and loadBalancingScheme unchecked. A
// ConfigMap carrying a VICTIM load balancer's forwarding rules plus those three expected
// strings passed verification, and this Job — running under a Workload Identity with
// networkservices.lbTrafficExtensions.* — attached the app's own extension to someone else's
// load balancer, putting their traffic through this routing service.
// ---------------------------------------------------------------------------
describe("S9: whole-document verification", () => {
  const args = {
    releaseName: "my-app",
    projectId: "p-123456",
    region: "us-central1",
    buildId: "b1",
  };

  it("embeds the rendered document's digest and compares it before importing", () => {
    renderRouteExtConfigMap({ releaseName: "my-app", extensionChainJson: MINIMAL_CHAIN_JSON });
    const digest = routeExtDocumentDigest();
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    const job = renderRouteExtUpdateJob({ ...args, documentDigest: digest });
    expect(job).toContain(`EXPECT_DIGEST="${digest}"`);
    expect(job).toContain("sha256sum /config/route-extension.yaml");
    expect(job).toContain("the mounted ConfigMap was modified after render");
  });

  it("requires the forwarding-rule placeholder, so rules can only come from discovery", () => {
    // The specific attack: a document with a victim's rules hardcoded and no placeholder.
    const job = renderRouteExtUpdateJob({ ...args, documentDigest: "a".repeat(64) });
    expect(job).toContain("grep -q 'FORWARDING_RULE_PLACEHOLDER' /config/route-extension.yaml");
    expect(job).toContain("forwarding rules must come from this Job's own");
  });

  it("the digest covers the fields the field-checks miss", () => {
    // Same release/project — so `service`, `authority` and `name` are all IDENTICAL — but a
    // different CEL match condition. The old checks passed this; the digest must not.
    const base = { releaseName: "my-app" };
    renderRouteExtConfigMap({ ...base, extensionChainJson: MINIMAL_CHAIN_JSON });
    const before = routeExtDocumentDigest();
    const tampered = JSON.parse(MINIMAL_CHAIN_JSON);
    tampered[0].matchCondition.celExpression = "false";
    renderRouteExtConfigMap({ ...base, extensionChainJson: JSON.stringify(tampered, null, 2) });
    expect(routeExtDocumentDigest()).not.toBe(before);
  });

  it("still renders (with the field checks as a floor) when no digest is supplied", () => {
    const job = renderRouteExtUpdateJob(args);
    expect(job).toContain('EXPECT_DIGEST=""');
    expect(job).toContain("route-extension.yaml service mismatch");
  });
});
