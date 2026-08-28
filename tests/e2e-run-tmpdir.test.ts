import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const helper = path.resolve("scripts/e2e-run-tmpdir.sh");

describe("E2E run temp directories", () => {
  it("removes only the scoped run directory", () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-tmp-parent-"));
    const sibling = path.join(parent, "keep");
    writeFileSync(sibling, "owned by another run");

    try {
      // Pass arguments separately so paths cannot become shell source.
      const scoped = execFileSync(
        "bash",
        [
          "-c",
          'source "$1"; target="$(create_e2e_run_tmpdir "$2")"; touch "$target/file"; cleanup_e2e_run_tmpdir "$2" "$target" "$3"; printf "%s" "$target"',
          "bash",
          helper,
          parent,
          path.resolve("."),
        ],
        { encoding: "utf8" },
      );

      expect(existsSync(scoped)).toBe(false);
      expect(existsSync(sibling)).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("refuses a target outside the configured parent", () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-tmp-parent-"));
    const outside = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-run."));
    try {
      const result = execFileSync(
        "bash",
        [
          "-c",
          'source "$1"; if cleanup_e2e_run_tmpdir "$2" "$3" "$4" 2>/dev/null; then printf accepted; else printf refused; fi',
          "bash",
          helper,
          parent,
          outside,
          path.resolve("."),
        ],
        { encoding: "utf8" },
      );

      expect(result).toBe("refused");
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("waits for run children to stop before cleanup can continue", () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-process-tree-"));
    const childPidFile = path.join(stateDir, "child-pid");
    try {
      const result = execFileSync(
        "bash",
        [
          "-c",
          'source "$1"; E2E_STOP_GRACE_TICKS=2; export E2E_STOP_GRACE_TICKS; bash -c \'trap "" TERM; while :; do sleep 30 & printf "%s" "$!" > "$1"; wait; done\' bash "$2" & parent=$!; while [ ! -s "$2" ]; do sleep 0.01; done; stop_e2e_children "$parent"; child="$(cat "$2")"; if kill -0 "$parent" 2>/dev/null || kill -0 "$child" 2>/dev/null; then printf alive; else printf stopped; fi',
          "bash",
          helper,
          childPidFile,
        ],
        { encoding: "utf8" },
      );
      expect(result).toBe("stopped");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
