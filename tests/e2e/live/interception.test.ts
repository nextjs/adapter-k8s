import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const BASE = process.env.E2E_INTERCEPTION_BASE_URL?.replace(/\/$/, "");
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium";

describe.skipIf(!BASE || !existsSync(CHROMIUM))("deployed interception fixture", () => {
  it("preserves rewritten dynamic params during an intercepted RSC navigation", () => {
    const profile = mkdtempSync(path.join(tmpdir(), "adapter-k8s-interception-chrome-"));
    try {
      const dom = execFileSync(
        CHROMIUM,
        [
          "--headless",
          "--no-sandbox",
          "--disable-dev-shm-usage",
          `--user-data-dir=${profile}`,
          "--virtual-time-budget=5000",
          "--dump-dom",
          `${BASE}/?navigate=1`,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(dom).toContain("intercepted:en:probe-user:1");
      expect(dom).toContain("target:en:probe-user:1");
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  });
});
