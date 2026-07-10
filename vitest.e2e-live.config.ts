// Live e2e suite — hits a DEPLOYED instance over the network. Kept separate from
// the default unit config (tests/**) so `vitest run` never makes network calls.
// Run with `npm run test:e2e:live` (optionally E2E_BASE_URL=...).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["e2e-live/**/*.test.ts"],
    // CDN edge-cache assertions poll with a retry budget; give them room.
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
