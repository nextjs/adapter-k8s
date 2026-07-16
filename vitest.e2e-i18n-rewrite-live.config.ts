import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e-i18n-rewrite-live/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
