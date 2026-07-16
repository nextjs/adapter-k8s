import type { NextConfig } from "next";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Cache Components (PPR + `use cache`) enabled — validates the adapter's Valkey-backed
// use-cache handler + pool-native PPR resume on GKE.
const nextConfig: NextConfig = {
  // Keep `npm run build` honest: the local fixture must exercise the adapter hooks even when it is
  // not launched through the deploy CLI (which otherwise supplies NEXT_ADAPTER_PATH).
  adapterPath: require.resolve("@next-community/adapter-k8s"),
  cacheComponents: true,
  // Keep the local deployed-app probe small enough to make a duplicated PPR Link header obvious.
  // React owns truncation; the adapter must preserve that budget when joining shell + resume.
  reactMaxHeadersLength: 400,
  async rewrites() {
    return [
      {
        // Repeated destination keys must reach Pages/App handlers as an array; URLSearchParams.set
        // silently collapses this to the final value, which this local fixture is designed to catch.
        source: "/rewrite-query-array",
        destination: "/api/rewrite-query-array?item=one&item=two",
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/header-priority.txt",
        headers: [{ key: "Cache-Control", value: "max-age=1234" }],
      },
      {
        source: "/sw-revalidation-probe.js",
        // Service workers are mutable build artifacts: the browser must check for an update, but
        // an ETag should turn an unchanged check into a body-less 304. This local fixture locks the
        // same cache contract as Next's generated `_next/static/service-worker/*` output.
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
