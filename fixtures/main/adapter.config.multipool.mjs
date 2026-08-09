import { createK8sAdapter } from "@next-community/adapter-k8s";

// Multi-pool variant of adapter.config.mjs — exists to exercise the shared-base
// pool image layout (poolImageLayout: shared-base-v1), which only activates when
// a build has more than one pool. Same infra/release as the default config.
export default createK8sAdapter({
  pools: {
    web: {
      routes: ["appPages", "pages"],
      scaling: { min: 2, max: 10, targetCPU: 70 },
    },
    api: {
      routes: ["appRoutes", "pagesApi"],
      scaling: { min: 1, max: 4, targetCPU: 70 },
    },
  },

  cache: {
    enabled: true,
    provider: "valkey",
    memorystore: { region: "us-central1", sizeGb: 1 },
  },
  containerStrategy: "traced-assets",

  provider: {
    gke: {
      cdn: {
        enabled: true,
        bucket: "praxis-road-491306-c0-nextjs-static",
      },
      gateway: {
        type: "gateway-api",
        className: "gke-l7-global-external-managed",
        hosts: [
          { hostname: "adapter-gke.jamesdaniels.net", tls: { enabled: true, managedCert: true } },
        ],
      },
    },
  },
});
