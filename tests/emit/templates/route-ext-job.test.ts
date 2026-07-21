import { describe, it, expect } from "vitest";
import {
  renderRouteExtUpdateJob,
  routeExtJobName,
} from "../../../src/emit/templates/route-ext-update-job.js";
import { renderRouteExtConfigMap } from "../../../src/emit/templates/route-ext-configmap.js";

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
      projectId: "my-project",
      region: "us-central1",
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
      projectId: "my-project",
      region: "us-central1",
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
