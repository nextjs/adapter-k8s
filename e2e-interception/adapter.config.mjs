import { createK8sAdapter } from "@next-community/adapter-k8s";

// Dedicated App Router fixture for middleware rewrites into interception routes. The main e2e app
// enables Cache Components, whose static-generation constraints are intentionally tested there and
// are incompatible with this dynamic interception topology.
export default createK8sAdapter({
  pools: { default: { routes: ["appPages"] } },
  containerStrategy: "traced-assets",
  provider: {
    gke: {
      gateway: {
        type: "gateway-api",
        className: "gke-l7-global-external-managed",
        hosts: [{ hostname: "interception-e2e.invalid", tls: { enabled: false } }],
      },
    },
  },
});
