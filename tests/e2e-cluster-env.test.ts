// The env-diff that lets the cluster topology forward a suite's `nextTestSetup({ env })` into
// the pod without also forwarding the build host's credentials. See the module header.
import { describe, it, expect } from "vitest";
import { harnessInjectedEnv } from "../scripts/e2e-cluster-env.mjs";

const baseline = ["PATH", "HOME", "GOOGLE_APPLICATION_CREDENTIALS", "AWS_SECRET_ACCESS_KEY"];

describe("harnessInjectedEnv", () => {
  it("forwards a variable the harness added", () => {
    const { env } = harnessInjectedEnv(
      { PATH: "/usr/bin", ANOTHER_MIDDLEWARE_TEST: "asdf2" },
      baseline,
    );
    expect(env).toEqual({ ANOTHER_MIDDLEWARE_TEST: "asdf2" });
  });

  it("never forwards ambient credentials that were already present", () => {
    // The entire reason this is a diff and not "forward everything".
    const { env } = harnessInjectedEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/u",
        GOOGLE_APPLICATION_CREDENTIALS: "/keys/sa.json",
        AWS_SECRET_ACCESS_KEY: "shhh",
        MIDDLEWARE_TEST: "asdf",
      },
      baseline,
    );
    expect(env).toEqual({ MIDDLEWARE_TEST: "asdf" });
  });

  it("forwards an ambient-NAMED variable only if it was absent from the snapshot", () => {
    // A suite is allowed to declare a variable that happens to look ambient; the snapshot,
    // not the name, decides.
    const { env } = harnessInjectedEnv({ DEBUG: "1" }, baseline);
    expect(env).toEqual({ DEBUG: "1" });
  });

  it("drops harness and adapter plumbing", () => {
    const { env } = harnessInjectedEnv(
      {
        NEXT_TEST_DIR: "/tmp/x",
        NEXT_TEST_MODE: "deploy",
        ADAPTER_K8S_SKIP_STAGING: "0",
        NEXT_ADAPTER_PATH: "/x/dist/index.js",
        __NEXT_CACHE_COMPONENTS: "1",
        npm_config_cache: "/x",
        REAL_ONE: "keep",
      },
      baseline,
    );
    expect(env).toEqual({ REAL_ONE: "keep" });
  });

  it("drops reserved names rather than letting validateConfig fail the deploy", () => {
    const { env, skipped } = harnessInjectedEnv({ NODE_ENV: "test", OK: "1" }, baseline);
    expect(env).toEqual({ OK: "1" });
    expect(skipped.join()).toMatch(/NODE_ENV/);
  });

  it("drops NEXT_PUBLIC_*, which the build already consumed", () => {
    const { env, skipped } = harnessInjectedEnv({ NEXT_PUBLIC_FOO: "bar" }, baseline);
    expect(env).toEqual({});
    expect(skipped.join()).toMatch(/NEXT_PUBLIC_FOO/);
  });

  it("drops a name Kubernetes would reject", () => {
    const { env, skipped } = harnessInjectedEnv({ "weird-name": "x", GOOD: "y" }, baseline);
    expect(env).toEqual({ GOOD: "y" });
    expect(skipped.join()).toMatch(/weird-name/);
  });

  it("drops the runner's own variables, which appear after the snapshot is taken", () => {
    // Exactly what the 2026-07-29 acceptance run forwarded before this filter existed.
    // NODE_PATH is the dangerous one — a host path in a container changes module resolution
    // for the pool server; the CI trio matters because a fixture may branch on it.
    const { env } = harnessInjectedEnv(
      {
        CI: "1",
        GITHUB_ACTIONS: "1",
        CIRCLECI: "true",
        CONTINUOUS_INTEGRATION: "1",
        BUILD_NUMBER: "7",
        RUN_ID: "abc",
        NODE_PATH: "/home/user/next.js/node_modules",
        JEST_WORKER_ID: "1",
        JEST_SUITE_NAME: "x",
        TEST_FILE_PATH: "/tmp/t.ts",
        HEADLESS: "true",
        TRACE_PLAYWRIGHT: "1",
        RUST_MIN_STACK: "8388608",
        UPSTASH_DISABLE_TELEMETRY: "1",
        _: "/usr/bin/node",
        ANOTHER_MIDDLEWARE_TEST: "asdf2",
        STRING_ENV_VAR: "asdf3",
        MIDDLEWARE_TEST: "asdf",
      },
      baseline,
    );
    expect(env).toEqual({
      ANOTHER_MIDDLEWARE_TEST: "asdf2",
      STRING_ENV_VAR: "asdf3",
      MIDDLEWARE_TEST: "asdf",
    });
  });

  it("refuses to forward a whole-shell dump when the baseline is missing", () => {
    // Demonstrated for real during development: with a truncated baseline the diff produced
    // 80 variables including PATH, XDG_*, and the session's own tooling env. Silently pushing
    // that into a pod spec is the worst outcome available here, so it must be an error.
    const whole = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`AMBIENT_${i}`, "value"]),
    );
    expect(() => harnessInjectedEnv(whole, [])).toThrow(/Refusing to forward 60/);
  });

  it("ignores an undefined value", () => {
    const { env } = harnessInjectedEnv({ UNSET: undefined, SET: "1" }, baseline);
    expect(env).toEqual({ SET: "1" });
  });
});
