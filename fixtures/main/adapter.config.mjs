import { createK8sAdapter } from "@next-community/adapter-k8s";

// Deploys to the existing `test-app` infra (cluster/gateway/IP/DNS/cert already
// provisioned). CDN is enabled here to validate the GCPHTTPFilter path on real
// infrastructure — the running rev-24 deployment predates that feature.
export default createK8sAdapter({
  middleCache: { enabled: true },
  pools: {
    default: {
      routes: ["appPages", "appRoutes", "pages", "pagesApi"],
      scaling: { min: 2, max: 10, targetCPU: 70 },
    },
  },

  cache: {
    enabled: true,
    provider: "valkey",
    // This fixture reuses a legacy plaintext instance. Declare its existing posture explicitly;
    // the default AUTH/TLS plan must reject it rather than silently accepting weaker settings.
    memorystore: { region: "us-central1", sizeGb: 1, auth: false },
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
