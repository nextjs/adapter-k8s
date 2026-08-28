// vitest.config.ts
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["tests/**/*.test.ts"],
    // Several integration files start Docker services. Letting Vitest size the worker pool from
    // every host core makes their image pulls, auth probes, and teardown compete until otherwise
    // healthy 10s hooks time out. Four keeps the hermetic unit suite parallel without stampeding
    // Docker Desktop (the same measured contention boundary as the cluster E2E harness).
    maxWorkers: 4,
    hookTimeout: 30_000,
    // Live suites under tests/e2e/live/ hit deployed instances over the network;
    // they run only via vitest.e2e-live.config.ts, never in the default `vitest run`.
    exclude: [...configDefaults.exclude, "tests/e2e/live/**"],
  },
});
