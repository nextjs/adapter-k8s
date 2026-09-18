import { execFileSync } from "node:child_process";
import { devNull } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

describe("E2E shell helpers", () => {
  it.each(["test-e2e-lock.sh", "test-e2e-next-checkout.sh"])("%s", (script) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
    );
    execFileSync("bash", [fileURLToPath(new URL(`../scripts/${script}`, import.meta.url))], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 10_000,
      env: { ...env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull },
    });
  });
});
