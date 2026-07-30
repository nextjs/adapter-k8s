import { createK8sAdapter } from "@next-community/adapter-k8s";

// GENERIC provider on a Scaleway managed cluster (3x arm64 nodes, Cilium CNI).
// No cloud CDN, no managed cache, no cloud IAM — the ext_proc routing tier runs behind an
// in-cluster Envoy Gateway, registered by an EnvoyExtensionPolicy.
export default createK8sAdapter({
  pools: {
    default: {
      routes: ["appPages", "appRoutes", "pages", "pagesApi"],
      scaling: { min: 1, max: 2, targetCPU: 70 },
    },
  },
  cache: { enabled: false },
  containerStrategy: "traced-assets",
  provider: {
    generic: {
      gateway: {
        className: "eg",
        hosts: [{ hostname: "scw.local", tls: { enabled: false } }],
      },
    },
  },
});
