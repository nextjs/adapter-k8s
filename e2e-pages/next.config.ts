import type { NextConfig } from "next";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const nextConfig: NextConfig = {
  // This fixture must run through the adapter even when built outside the deploy CLI.
  adapterPath: require.resolve("@next-community/adapter-k8s"),
  i18n: {
    defaultLocale: "en-US",
    locales: ["en-US", "fr"],
  },
};

export default nextConfig;
