import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../../src/cli/exec.js", () => ({
  execCapture: vi.fn(),
  EXEC_TIMEOUTS: { kubectl: 30000 },
}));
import { execCapture } from "../../src/cli/exec.js";
import { protectRetentionBuild, setRetentionExpiry } from "../../src/cutover/retention-expiry.js";
import { RETENTION_EXPIRY_ANNOTATION } from "../../src/retention-expiry.js";
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(execCapture).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
});
it("renews the cleanup fence before a rollback target wakes, even if the CLI later dies", async () => {
  const start = Date.now();
  await protectRetentionBuild("rel", "ns", "old", ["web"]);
  const args = vi.mocked(execCapture).mock.calls[0]![1];
  expect(args.slice(0, 3)).toEqual(["patch", "deployment", "rel-web-old"]);
  const marker = JSON.parse(
    JSON.parse(args[args.indexOf("-p") + 1]!).metadata.annotations[RETENTION_EXPIRY_ANNOTATION],
  );
  expect(marker.buildId).toBe("old");
  expect(marker.expiresAt).toBeGreaterThanOrEqual(start + 3_600_000);
  expect(marker.expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
});
it("permits a plain GitOps Job to start before the target Deployment exists", async () => {
  vi.mocked(execCapture).mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "not found" });
  await protectRetentionBuild("rel", "ns", "new", ["web"]);
  expect(execCapture).toHaveBeenCalledTimes(2);
});
it("aborts promotion if an existing Deployment cannot be protected", async () => {
  vi.mocked(execCapture)
    .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "denied" })
    .mockResolvedValueOnce({ exitCode: 0, stdout: "deployment/rel-web-old", stderr: "" });
  await expect(protectRetentionBuild("rel", "ns", "old", ["web"])).rejects.toThrow("Could not arm");
});
it("does not silently lose an outgoing cleanup deadline", async () => {
  vi.mocked(execCapture).mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "denied" });
  await expect(setRetentionExpiry("rel", "ns", "old", ["web"], 1000)).rejects.toThrow(
    "Could not arm",
  );
  expect(execCapture).toHaveBeenCalledTimes(1);
});
