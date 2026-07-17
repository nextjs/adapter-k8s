import type { NextConfig } from "next";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const nextConfig: NextConfig = {
  adapterPath: require.resolve("@next-community/adapter-k8s"),
  i18n: {
    defaultLocale: "en",
    locales: ["en", "nl-NL"],
  },
  async rewrites() {
    return [{ source: "/", destination: "/company/about-us" }];
  },
};

export default nextConfig;
