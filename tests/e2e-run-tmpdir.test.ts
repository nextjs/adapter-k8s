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
          `source "$1"
          export E2E_STOP_GRACE_TICKS=2
          bash -c 'trap "" TERM; while :; do sleep 30 & printf "%s" "$!" > "$1"; wait; done' bash "$2" &
          parent=$!
          child=""
          trap 'kill -KILL "$parent" "$child" 2>/dev/null || true; wait "$parent" 2>/dev/null || true' EXIT
          while [ ! -s "$2" ]; do sleep 0.01; done
          child="$(cat "$2")"
          stop_e2e_children "$parent"
          child="$(cat "$2")"
          is_running() {
            local state
            state="$(ps -o stat= -p "$1" 2>/dev/null)" || return 1
            [[ -n "$state" && "$state" != *Z* ]]
          }
          # Orphaned zombies have exited but kill -0 succeeds until the host init reaps them.
          # Allow signal delivery to finish, while still rejecting any live descendant.
          for ((tick = 0; tick < 100; tick++)); do
            if ! is_running "$parent" && ! is_running "$child"; then printf stopped; exit; fi
            sleep 0.01
          done
          printf alive`,
          "bash",
          helper,
          childPidFile,
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(result).toBe("stopped");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
