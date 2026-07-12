import type { NextConfig } from "next";

// Cache Components (PPR + `use cache`) enabled — validates the adapter's Valkey-backed
// use-cache handler + pool-native PPR resume on GKE.
const nextConfig: NextConfig = { cacheComponents: true };

export default nextConfig;
