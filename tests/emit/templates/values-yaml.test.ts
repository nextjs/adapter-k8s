import { describe, expect, it } from "vitest";
import {
  DEFAULT_POOL_RESOURCES,
  DEFAULT_POOL_SCALING,
  renderValuesYaml,
} from "../../../src/emit/templates/values-yaml.js";
import type { K8sAdapterConfig, PoolDefinition } from "../../../src/types.js";

const config = {
  pools: { ssr: { routes: ["appPages"] } },
  provider: { gke: {} },
} as unknown as K8sAdapterConfig;

function render(poolConfig: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  const pools = new Map<string, PoolDefinition>([
    [
      "ssr",
      { name: "ssr", outputs: [], config: { routes: ["appPages"], ...poolConfig } },
    ] as unknown as [string, PoolDefinition],
  ]);
  return renderValuesYaml({
    pools,
    buildId: "b1",
    nextVersion: "16.2.0",
    config,
    imageRegistry: "us-docker.pkg.dev/p/r",
    targetPlatform: "linux/amd64",
    ...overrides,
  } as Parameters<typeof renderValuesYaml>[0]);
}

describe("renderValuesYaml", () => {
  it("emits the documented defaults when next.config says nothing", () => {
    const values = JSON.parse(render().slice(render().indexOf("{")));
    expect(values.pools.ssr.resources).toEqual({
      requests: { cpu: DEFAULT_POOL_RESOURCES.cpu, memory: DEFAULT_POOL_RESOURCES.memory },
      limits: { cpu: DEFAULT_POOL_RESOURCES.cpuLimit, memory: DEFAULT_POOL_RESOURCES.memoryLimit },
    });
    expect(values.pools.ssr.replicas).toEqual(DEFAULT_POOL_SCALING);
    expect(values.global.targetArchitecture).toBe("amd64");
  });

  it("records arm64 scheduling for an arm64 image build", () => {
    const values = JSON.parse(
      render({}, { targetPlatform: "linux/arm64" }).slice(render().indexOf("{")),
    );
    expect(values.global.targetArchitecture).toBe("arm64");
  });

  // -------------------------------------------------------------------------
  // N68 — reproducible renders
  // -------------------------------------------------------------------------
  it("N68: two renders of the same build are byte-identical (no wall-clock stamp)", () => {
    // The header used to carry `# Generated: <ISO now>`, so a regenerated chart could never
    // be diffed against what was applied — the only practical audit of invariant 5.
    expect(render()).toBe(render());
    expect(render()).not.toMatch(/# Generated:/);
    expect(render()).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // The header still identifies the build.
    expect(render()).toContain("# Build ID: b1");
    expect(render()).toContain("# Next.js: 16.2.0");
  });

  // -------------------------------------------------------------------------
  // N60 — resource / scaling injection
  // -------------------------------------------------------------------------
  it.each([
    [
      "memoryLimit",
      '512Mi"\n      hostNetwork: true\n      shareProcessNamespace: true\n  _pad: "',
    ],
    ["cpu", '250m"\n      hostNetwork: true\n      _pad: "'],
    ["memory", "256Mi\n_x: y"],
    ["cpuLimit", "1; touch /tmp/pwned"],
  ])("N60: rejects an injected pools.*.resources.%s", (field, payload) => {
    expect(() => render({ resources: { [field]: payload } })).toThrow(
      /Invalid Kubernetes quantity/,
    );
  });

  it("N60: accepts the real quantity forms an operator needs", () => {
    for (const q of ["1", "1.5", "250m", "512Mi", "2Gi", "1000", "64Ki"]) {
      expect(() => render({ resources: { memory: q } })).not.toThrow();
    }
  });

  it("N60: rejects non-integer / injected scaling values (bare `minReplicas: {{ … }}` sink)", () => {
    expect(() => render({ scaling: { min: "1\n  INJECTED: yes", max: 3, targetCPU: 80 } })).toThrow(
      /scaling\.min/,
    );
    expect(() => render({ scaling: { min: 1.5, max: 3, targetCPU: 80 } })).toThrow(/scaling\.min/);
    expect(() => render({ scaling: { min: 1, max: 3, targetCPU: 0 } })).toThrow(
      /scaling\.targetCPU/,
    );
    expect(() => render({ scaling: { min: 1, max: 3, targetCPU: 10_001 } })).toThrow(
      /scaling\.targetCPU/,
    );
    expect(() => render({ scaling: { min: -1, max: 3, targetCPU: 80 } })).toThrow(/scaling\.min/);
  });

  it("N60: fills each scaling field independently, so a partial object can't emit `undefined`", () => {
    const values = JSON.parse(
      render({ scaling: { min: 4 } }).slice(render({ scaling: { min: 4 } }).indexOf("{")),
    );
    expect(values.pools.ssr.replicas).toEqual({
      min: 4,
      max: DEFAULT_POOL_SCALING.max,
      targetCPU: DEFAULT_POOL_SCALING.targetCPU,
    });
  });

  // -------------------------------------------------------------------------
  // Cross-cutting: sanitize at the point of consumption
  // -------------------------------------------------------------------------
  it("validates buildId, imageRegistry and pool names here (none was checked before)", () => {
    expect(() => render({}, { buildId: 'a"\nx: y' })).toThrow(/Invalid buildId/);
    expect(() => render({}, { imageRegistry: "REG!!/x" })).toThrow(/Invalid image registry/);
    // adapter.ts's own "not configured yet" literal stays accepted (deploy --sets over it).
    expect(() => render({}, { imageRegistry: "REGISTRY" })).not.toThrow();
  });

  it("accepts a registry host with a PORT (local/LAN registries)", () => {
    // `host:port/path` is standard OCI reference syntax — a colon in the FIRST segment is a
    // port, not a tag; only a colon in the LAST segment is a tag. The validator rejected
    // every local registry (k3d, kind, a LAN Harbor): found by Phase 2's first-ever deploy,
    // which died on "localhost:5511/adapter-e2e". The sibling IMAGE_REFERENCE_RE below it
    // already allowed the port — the two had drifted.
    expect(() => render({}, { imageRegistry: "localhost:5511/adapter-e2e" })).not.toThrow();
    expect(() => render({}, { imageRegistry: "registry.lan:5000/team/nextjs" })).not.toThrow();
    // A tag is still rejected — the tag is the build id, applied separately.
    expect(() => render({}, { imageRegistry: "ghcr.io/foo/bar:latest" })).toThrow(
      /Invalid image registry/,
    );
    // A port alone (no repo path) with junk stays rejected.
    expect(() => render({}, { imageRegistry: "localhost:notaport/x" })).toThrow(
      /Invalid image registry/,
    );
  });
});

describe("poolHealthCheckPath (first-upgrade probe migration)", () => {
  it("defaults to the readiness path", () => {
    const yaml = render({});
    expect(yaml).toContain('"poolHealthCheckPath": "/readyz"');
  });
});
