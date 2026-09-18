import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compressionFilters } from "../../src/emit/envoy-compression.js";
import { renderDeployment } from "../../src/emit/templates/deployment.js";

describe("response compression wiring", () => {
  it.each([false, true])("keeps public probes on Envoy with middleCache=%s", (middleCache) => {
    const yaml = renderDeployment({
      releaseName: "app",
      poolName: "ssr",
      buildId: "b1",
      middleCache,
    });
    expect(yaml).toContain("- name: compression");
    expect(yaml).toContain('name: PORT\n              value: "3001"');
    expect(yaml).toContain('name: ADAPTER_K8S_LISTEN_HOST\n              value: "127.0.0.1"');
    const argument = yaml.split("- --config-yaml\n            - ")[1]!.split("\n")[0]!;
    const config = JSON.parse(JSON.parse(argument));
    expect(
      config.static_resources.clusters[0].load_assignment.endpoints[0].lb_endpoints[0].endpoint
        .address.socket_address,
    ).toEqual({ address: "127.0.0.1", port_value: middleCache ? 3002 : 3001 });
    expect(config.static_resources.listeners[0].address.socket_address.port_value).toBe(3000);
    expect(yaml).not.toMatch(/httpGet:\n\s+path: \S+\n\s+port: 300[12]/);
    if (middleCache) expect(yaml).toContain('value: "127.0.0.1:3002"');
  });

  it.each([false, true])("can disable compression with middleCache=%s", (middleCache) => {
    const yaml = renderDeployment({
      releaseName: "app",
      poolName: "ssr",
      buildId: "b1",
      middleCache,
      compression: false,
    });
    expect(yaml).not.toContain("- name: compression");
    expect(yaml).toContain(`containerPort: ${middleCache ? 3001 : 3000}`);
    if (middleCache) expect(yaml).toContain('value: ":3000"');
  });

  it("uses the same compression filters in emulation and pool proxies", () => {
    const source = readFileSync(new URL("../../integration/envoy.yaml", import.meta.url), "utf8");
    const filters = source
      .split("\n")
      .filter((line) => line.trim().startsWith('- {"name":"envoy.filters.http.compressor.'))
      .map((line) => JSON.parse(line.trim().slice(2)));
    expect(filters).toEqual(compressionFilters());
  });
});
