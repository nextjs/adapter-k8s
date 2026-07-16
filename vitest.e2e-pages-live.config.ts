import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e-pages-live/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
