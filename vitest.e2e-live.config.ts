// Live e2e suite — hits DEPLOYED instances over the network. Kept separate from
// the default unit config (tests/**) so `vitest run` never makes network calls.
//
// Every suite under tests/e2e/live/ self-gates on its own base-URL env var via
// describe.skipIf, so running the whole config only exercises the suites whose
// deployment you've pointed at:
//
//   E2E_BASE_URL=https://…              npm run test:e2e:live  # flagship (deployed.test.ts)
//   E2E_PAGES_BASE_URL=https://…        npm run test:e2e:live  # pages.test.ts
//   E2E_EDGE_BASE_URL=https://…         npm run test:e2e:live  # edge.test.ts
//   E2E_INTERCEPTION_BASE_URL=https://… npm run test:e2e:live  # interception.test.ts (needs CHROMIUM_PATH)
//   E2E_I18N_REWRITE_BASE_URL=https://… npm run test:e2e:live  # i18n-rewrite.test.ts
//
// To run a single suite regardless of env gating, pass its file:
//   npm run test:e2e:live -- tests/e2e/live/edge.test.ts
//
// One assertion inside deployed.test.ts is gated separately, on a capability rather than a
// URL: E2E_ASSERT_EDGE_DISPATCH=1 asserts that trusted dispatch is actually being TAKEN
// (middleware ran in the ext_proc tier, i.e. the pool verified the dispatch proof instead of
// failing safe to local re-resolution). It reads a marker the flagship fixture stamps, so it
// requires a deployment built from the current fixtures/main — hence opt-in.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["tests/e2e/live/**/*.test.ts"],
    // CDN edge-cache assertions poll with a retry budget; give them room.
    // 60s covers the most generous suite (flagship); the others are well under.
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
