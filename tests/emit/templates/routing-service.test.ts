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
    expect(yaml).toContain("cpu: 500m");
    expect(yaml).toContain("cpu: 2");
    expect(yaml).toContain("memory: 1Gi");
    expect(yaml).toMatch(/ROUTING_FAIL_OPEN[\s\S]*?value: "false"/);
    expect(yaml).toContain('value: "3000"');
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
