import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e-interception-live/**/*.test.ts"],
    testTimeout: 35_000,
  },
});
