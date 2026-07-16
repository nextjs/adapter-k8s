import { createK8sAdapter } from "@next-community/adapter-k8s";

// Edge runtime segment config is incompatible with cacheComponents in Next 16. Keep this fixture
// separate from e2e/ so the adapter's PPR and Edge invocation contracts are both build-tested.
export default createK8sAdapter({
  pools: { default: { routes: ["appPages", "appRoutes"] } },
  containerStrategy: "traced-assets",
  provider: {
    gke: {
      gateway: {
        type: "gateway-api",
        className: "gke-l7-global-external-managed",
        hosts: [{ hostname: "edge-e2e.invalid", tls: { enabled: false } }],
      },
    },
  },
});
