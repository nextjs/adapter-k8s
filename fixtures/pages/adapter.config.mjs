import { createK8sAdapter } from "@next-community/adapter-k8s";

// Pages-only fixture: an app-wide getInitialProps packages 404 rendering behind /_error instead
// of emitting a standalone /404 handler. Keep it separate from the App Router/PPR fixture so the
// App Router's /_not-found output cannot hide the Pages entrypoint contract under test.
export default createK8sAdapter({
  pools: { default: { routes: ["pages", "pagesApi"] } },
  containerStrategy: "traced-assets",
  provider: {
    gke: {
      gateway: {
        type: "gateway-api",
        className: "gke-l7-global-external-managed",
        hosts: [{ hostname: "pages-e2e.invalid", tls: { enabled: false } }],
      },
    },
  },
});
