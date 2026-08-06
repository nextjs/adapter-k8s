import { describe, expect, it } from "vitest";
import { renderComposedResources } from "../../../src/emit/templates/composed-resources.js";

describe("renderComposedResources", () => {
  it("renders deterministic JSON documents that Helm accepts as YAML", () => {
    const files = renderComposedResources([
      {
        apiVersion: "example.com/v1",
        kind: "Widget",
        resource: "widgets",
        metadata: {
          name: "sample",
          namespace: "apps",
          labels: { "adapter-k8s.dev/release": "site" },
        },
        body: { spec: { enabled: true } },
      },
    ]);
    expect(Object.keys(files)).toEqual(["templates/target-000-widget-sample.yaml"]);
    expect(JSON.parse(Object.values(files)[0]!)).toMatchObject({
      apiVersion: "example.com/v1",
      kind: "Widget",
      metadata: { name: "sample", namespace: "apps" },
      spec: { enabled: true },
    });
  });

  it("prevents contributed strings from being evaluated as Helm actions", () => {
    const files = renderComposedResources([
      {
        apiVersion: "v1",
        kind: "ConfigMap",
        resource: "configmaps",
        metadata: { name: "literal", namespace: "apps" },
        body: { data: { template: "{{ mul 7 6 }}" } },
      },
    ]);
    expect(Object.values(files)[0]).toContain('{{ "{{" }} mul 7 6 }}');
  });
});
