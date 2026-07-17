// vitest.config.ts
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["tests/**/*.test.ts"],
    // Live suites under tests/e2e/live/ hit deployed instances over the network;
    // they run only via vitest.e2e-live.config.ts, never in the default `vitest run`.
    exclude: [...configDefaults.exclude, "tests/e2e/live/**"],
  },
});
