import { createK8sAdapter } from "@next-community/adapter-k8s";

// Dedicated Pages/i18n fixture: its root rewrite intentionally conflicts with rendering a root
// page, so it cannot share the general Pages fixture that tests root data-route negotiation.
export default createK8sAdapter({
  pools: { default: { routes: ["pages"] } },
  containerStrategy: "traced-assets",
  provider: {
    gke: {
      gateway: {
        type: "gateway-api",
        className: "gke-l7-global-external-managed",
        hosts: [{ hostname: "i18n-rewrite-e2e.invalid", tls: { enabled: false } }],
      },
    },
  },
});
