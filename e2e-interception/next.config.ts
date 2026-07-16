import type { NextConfig } from "next";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const nextConfig: NextConfig = {
  adapterPath: require.resolve("@next-community/adapter-k8s"),
};

export default nextConfig;
