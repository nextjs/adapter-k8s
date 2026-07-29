import { describe, it, expect } from "vitest";
import { renderRoutingServiceDeployment } from "../../../src/emit/templates/routing-service-deployment.js";
import { renderRoutingServiceService } from "../../../src/emit/templates/routing-service-service.js";
import { renderRoutingServiceHPA } from "../../../src/emit/templates/routing-service-hpa.js";

describe("renderRoutingServiceDeployment", () => {
  it("renders a Deployment for the routing service", () => {
    const yaml = renderRoutingServiceDeployment({
      releaseName: "my-app",
      buildId: "abc123",
      imageRegistry: "reg",
    });
    expect(yaml).toContain("kind: Deployment");
    expect(yaml).toContain("my-app-routing-service");
    expect(yaml).toContain("containerPort: 8443");
    expect(yaml).toContain("routing-manifest");
    // Hardening: httpGet health probe (not tcpSocket), health port, timeout env.
    expect(yaml).toContain("containerPort: 8081");
    expect(yaml).toContain("path: /healthz");
    expect(yaml).not.toContain("tcpSocket");
    expect(yaml).toContain("ROUTING_REQUEST_TIMEOUT_MS");
    // Fail-open defaults true when not specified.
    expect(yaml).toMatch(/ROUTING_FAIL_OPEN[\s\S]*?value: "true"/);
  });

  it("honors resource overrides and fail-closed policy", () => {
    const yaml = renderRoutingServiceDeployment({
      releaseName: "my-app",
      buildId: "abc123",
      imageRegistry: "reg",
      resources: { cpu: "500m", memory: "512Mi", cpuLimit: "2", memoryLimit: "1Gi" },
      failOpen: false,
      requestTimeoutMs: 3000,
    });
    // Quoted at the sink now (N60): these were bare scalars, which is how
    // `cpu: "250m\n              INJECTED: yes"` injected a sibling key.
    expect(yaml).toContain('cpu: "500m"');
    expect(yaml).toContain('cpu: "2"');
    expect(yaml).toContain('memory: "1Gi"');
    expect(yaml).toMatch(/ROUTING_FAIL_OPEN[\s\S]*?value: "false"/);
    expect(yaml).toContain('value: "3000"');
  });

  it("ships the hardened pod/container security posture", () => {
    const yaml = renderRoutingServiceDeployment({
      releaseName: "my-app",
      buildId: "abc123",
      imageRegistry: "reg",
    });
    // Pod level: non-root uid 1000 (the node user), seccomp, no SA token (the routing
    // service never calls the Kubernetes API).
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
    // A writable /tmp (emptyDir) backs the read-only root filesystem — the runtime TLS
    // cert generation writes under /tmp/tls.
    expect(yaml).toMatch(/volumeMounts:[\s\S]*?name: tmp\n\s+mountPath: \/tmp/);
    expect(yaml).toMatch(/volumes:[\s\S]*?name: tmp\n\s+emptyDir:\n\s+sizeLimit: 64Mi/);
  });

  it("injects RELEASE_NAME and NAMESPACE so the runtime can build the cert CN/SAN", () => {
    const yaml = renderRoutingServiceDeployment({
      releaseName: "my-app",
      buildId: "abc123",
      imageRegistry: "reg",
    });
    expect(yaml).toMatch(/- name: RELEASE_NAME\n\s+value: "my-app"/);
    expect(yaml).toMatch(
      /- name: NAMESPACE\n\s+valueFrom:\n\s+fieldRef:\n\s+fieldPath: metadata\.namespace/,
    );
  });
});

describe("renderRoutingServiceService", () => {
  it("renders a Service for the routing service", () => {
    const yaml = renderRoutingServiceService({ releaseName: "my-app" });
    // Standalone NEG so the ext_proc traffic-extension backend service can attach it.
    expect(yaml).toContain("cloud.google.com/neg");
    expect(yaml).toContain("my-app-routing-neg");
    expect(yaml).toContain("exposed_ports");
    expect(yaml).toContain("kind: Service");
    expect(yaml).toContain("my-app-routing-service");
    expect(yaml).toContain("port: 8443");
    expect(yaml).toContain("appProtocol: grpc");
  });
});

describe("renderRoutingServiceHPA", () => {
  it("renders an HPA for the routing service", () => {
    const yaml = renderRoutingServiceHPA({
      releaseName: "my-app",
      minReplicas: 2,
      maxReplicas: 10,
    });
    expect(yaml).toContain("kind: HorizontalPodAutoscaler");
    expect(yaml).toContain("minReplicas: 2");
    expect(yaml).toContain("maxReplicas: 10");
  });
});

// ---------------------------------------------------------------------------
// N60 / N63 / N65 / N70 / N72 — the routing tier's half of the review findings.
// ---------------------------------------------------------------------------
describe("renderRoutingServiceDeployment — review findings", () => {
  const base = { releaseName: "my-app", buildId: "abc123", imageRegistry: "us-docker.pkg.dev/p/r" };
  const yamlOnly = (doc: string) =>
    doc
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");

  it("N60: rejects every injected resource quantity (these were UNQUOTED sinks)", () => {
    // Verified before the fix: `cpu: "250m\n              INJECTED: yes"` injected a
    // sibling key into the container's `resources` block on the first try — no
    // quote-escaping was needed at all because the interpolation was bare.
    for (const field of ["cpu", "memory", "cpuLimit", "memoryLimit"] as const) {
      expect(() =>
        renderRoutingServiceDeployment({
          ...base,
          resources: { [field]: "250m\n              INJECTED: yes" },
        }),
      ).toThrow(/Invalid Kubernetes quantity/);
    }
  });

  it("N60: quotes the quantities it does emit", () => {
    const yaml = renderRoutingServiceDeployment(base);
    expect(yaml).toMatch(/requests:\n\s+cpu: "500m"\n\s+memory: "512Mi"/);
    expect(yaml).not.toMatch(/^\s+cpu: [^"]/m);
    expect(yaml).not.toMatch(/^\s+memory: [^"]/m);
  });

  it("N70: requests == limits by default, memory at the Autopilot 512 MiB floor", () => {
    // https://docs.cloud.google.com/kubernetes-engine/docs/concepts/autopilot-resource-requests
    // — without bursting "GKE sets the `limits` equal to the `requests`", and the
    // general-purpose minimum memory request is 512 MiB. init.ts defaults autopilot=true,
    // so the old 250m/1000m "full core of burst headroom" comment was false on the default
    // cluster type, and the old 256Mi request was silently rewritten by GKE.
    const yaml = renderRoutingServiceDeployment(base);
    expect(yaml).toMatch(
      /resources:\n\s+requests:\n\s+cpu: "500m"\n\s+memory: "512Mi"\n\s+limits:\n\s+cpu: "500m"\n\s+memory: "512Mi"/,
    );
    // memory:CPU must stay within 1:1 .. 1:6.5 GiB-per-vCPU — 0.5 vCPU + 0.5 GiB is 1:1.
    expect(yaml).not.toContain('memory: "256Mi"');
    // The stale claim is gone.
    expect(yaml).not.toContain("full core of burst headroom");
  });

  it("N70: an operator can still opt into burst on a Standard cluster", () => {
    const yaml = renderRoutingServiceDeployment({
      ...base,
      resources: { cpu: "500m", cpuLimit: "2" },
    });
    expect(yaml).toMatch(/requests:\n\s+cpu: "500m"/);
    expect(yaml).toMatch(/limits:\n\s+cpu: "2"/);
    // An override of only `cpu` still yields requests == limits (memory follows too).
    const partial = renderRoutingServiceDeployment({ ...base, resources: { cpu: "1" } });
    expect(partial).toMatch(/requests:\n\s+cpu: "1"\n\s+memory: "512Mi"/);
    expect(partial).toMatch(/limits:\n\s+cpu: "1"\n\s+memory: "512Mi"/);
  });

  it("N63: preStop and grace match the measured ~90s NEG drain (was sleep 25 / grace 40)", () => {
    const yaml = renderRoutingServiceDeployment(base);
    // The old values contradicted this file's OWN comment measuring ~90s.
    expect(yaml).toContain('command: ["/bin/sh", "-c", "sleep 120"]');
    expect(yaml).toContain("terminationGracePeriodSeconds: 210");
    expect(yamlOnly(yaml)).not.toContain("sleep 25");
    expect(yamlOnly(yaml)).not.toContain("terminationGracePeriodSeconds: 40");
  });

  it("N65: emits a PodDisruptionBudget and a soft hostname spread", () => {
    const yaml = renderRoutingServiceDeployment(base);
    // ext_proc is fail-CLOSED whenever the app has middleware, so losing both replicas is
    // a total 500 — and with no PDB the eviction API drains both at once (GKE node
    // auto-upgrade / Autopilot bin-packing are routine voluntary evictions).
    expect(yaml).toContain("kind: PodDisruptionBudget");
    expect(yaml).toContain("name: my-app-routing-service-pdb");
    expect(yaml).toContain("minAvailable: 1");
    expect(yaml).toContain("topologySpreadConstraints:");
    expect(yaml).toContain("topologyKey: kubernetes.io/hostname");
    expect(yaml).toContain("whenUnsatisfiable: ScheduleAnyway");
  });

  it("N69: bounds the /tmp emptyDir and stops calling it in-memory", () => {
    const yaml = renderRoutingServiceDeployment(base);
    expect(yaml).toMatch(/name: tmp\n\s+emptyDir:\n\s+sizeLimit: 64Mi/);
    expect(yamlOnly(yaml)).not.toContain("medium: Memory");
  });

  it("N71: explicit probe timings on both probes (no inherited 1s timeout)", () => {
    const yaml = renderRoutingServiceDeployment(base);
    expect(yamlOnly(yaml)).not.toMatch(/timeoutSeconds: 1$/m);
    expect(yaml).toMatch(/readinessProbe:[\s\S]*?timeoutSeconds: 3/);
    expect(yaml).toMatch(/livenessProbe:[\s\S]*?timeoutSeconds: 5/);
  });

  it("N72: imagePullPolicy is explicit; a digest pins the image immutably", () => {
    // S7: no render-time digest ⇒ helm decides, from `routingService.image.digest` in values
    // (the digest only exists after `docker push`, which happens after the chart is generated).
    expect(renderRoutingServiceDeployment(base)).toContain(
      "{{ with .Values.routingService.image.digest }}IfNotPresent{{ else }}Always{{ end }}",
    );
    const digest = `sha256:${"b".repeat(64)}`;
    const pinned = renderRoutingServiceDeployment({ ...base, imageDigest: digest });
    expect(pinned).toContain(`image: "us-docker.pkg.dev/p/r/routing-service@${digest}"`);
    expect(pinned).toContain("imagePullPolicy: IfNotPresent");
  });

  it("sanitizes releaseName / buildId / imageRegistry at the consumption point", () => {
    expect(() => renderRoutingServiceDeployment({ ...base, releaseName: "Bad" })).toThrow(
      /Invalid releaseName/,
    );
    expect(() => renderRoutingServiceDeployment({ ...base, buildId: 'a"\nx: y' })).toThrow(
      /Invalid buildId/,
    );
    expect(() => renderRoutingServiceDeployment({ ...base, imageRegistry: "REG!/x" })).toThrow(
      /Invalid image registry/,
    );
    // adapter.ts's "not configured yet" literal is still accepted.
    expect(() =>
      renderRoutingServiceDeployment({ ...base, imageRegistry: "REGISTRY" }),
    ).not.toThrow();
  });

  it("rejects a non-integer requestTimeoutMs (interpolated into a pod env value)", () => {
    expect(() =>
      renderRoutingServiceDeployment({
        ...base,
        requestTimeoutMs: '4000"\n            - name: X' as unknown as number,
      }),
    ).toThrow(/requestTimeoutMs/);
  });
});
