// tests/cli/parse-args.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseArgs } from "../../src/cli/index.js";

const argv = (...args: string[]) => ["node", "adapter-k8s", ...args];

describe("parseArgs", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("parses the command", () => {
    expect(parseArgs(argv("deploy")).command).toBe("deploy");
    expect(parseArgs(argv()).command).toBe("help");
  });

  it("boolean flags never consume the following argument", () => {
    // Regression: `--dry-run foo` used to store "foo" as the flag's value, and since
    // consumers check `flags["dry-run"] === true`, the stray positional silently
    // DISABLED dry-run — the dangerous direction for destroy/deploy.
    const { flags } = parseArgs(argv("destroy", "--dry-run", "foo"));
    expect(flags["dry-run"]).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"foo"'));
  });

  it("supports the --flag=value form", () => {
    // Regression: `--project-id=x` used to register a flag literally named
    // "project-id=x" that no consumer reads.
    const { flags } = parseArgs(argv("init", "--project-id=my-proj", "--region=europe-west1"));
    expect(flags["project-id"]).toBe("my-proj");
    expect(flags["region"]).toBe("europe-west1");
    expect(flags["project-id=my-proj"]).toBeUndefined();
  });

  it("supports the --flag value form", () => {
    const { flags } = parseArgs(argv("init", "--project-id", "my-proj", "--namespace", "apps"));
    expect(flags["project-id"]).toBe("my-proj");
    expect(flags["namespace"]).toBe("apps");
  });

  it("value flags hard-error when the value is missing", () => {
    expect(() => parseArgs(argv("init", "--project-id"))).toThrow(/requires a value/);
    // A following flag must not be swallowed as the value.
    expect(() => parseArgs(argv("init", "--project-id", "--dry-run"))).toThrow(/requires a value/);
    expect(() => parseArgs(argv("init", "--host="))).toThrow(/non-empty value/);
  });

  it("recognizes every boolean flag used by the commands", () => {
    const { flags } = parseArgs(
      argv(
        "deploy",
        "--dry-run",
        "--skip-build",
        "--skip-push",
        "--yes",
        "-y",
        "--allow-no-network-policy",
        "--standard",
      ),
    );
    expect(flags["dry-run"]).toBe(true);
    expect(flags["skip-build"]).toBe(true);
    expect(flags["skip-push"]).toBe(true);
    expect(flags["yes"]).toBe(true);
    expect(flags["y"]).toBe(true);
    expect(flags["allow-no-network-policy"]).toBe(true);
    expect(flags["standard"]).toBe(true);
  });

  it("boolean flags reject an inline value with a warning but stay enabled", () => {
    // `--dry-run=false` must NOT disable dry-run — failing safe beats guessing intent.
    const { flags } = parseArgs(argv("destroy", "--dry-run=false"));
    expect(flags["dry-run"]).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("boolean flag"));
  });

  it("warns on unknown flags and does not record or consume anything for them", () => {
    const { flags } = parseArgs(argv("deploy", "--frobnicate", "extra"));
    expect(flags["frobnicate"]).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("unknown flag --frobnicate"));
    // The following arg is NOT consumed as the unknown flag's value.
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"extra"'));
  });

  it("warns on unknown short flags", () => {
    const { flags } = parseArgs(argv("destroy", "-z"));
    expect(flags["z"]).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("unknown flag -z"));
  });

  it("value flags accept values that follow the = sign even when they start with -", () => {
    const { flags } = parseArgs(argv("emulate", "--port=9090"));
    expect(flags["port"]).toBe("9090");
  });

  it("--help / -h route to the help command instead of running the real command", () => {
    // Regression: --help/-h were recognized boolean flags that no command consumed, so
    // `adapter-k8s deploy --help` dispatched a REAL deploy.
    expect(parseArgs(argv("deploy", "--help")).command).toBe("help");
    expect(parseArgs(argv("destroy", "-h")).command).toBe("help");
    expect(parseArgs(argv("--help")).command).toBe("--help"); // main() maps this case itself
  });

  it("--port is range-validated at the boundary", () => {
    // Regression: parseInt("abc", 10) is NaN and used to flow into emulate's Envoy
    // listener config with no error at all.
    expect(() => parseArgs(argv("emulate", "--port", "abc"))).toThrow(
      /integer between 1 and 65535/,
    );
    expect(() => parseArgs(argv("emulate", "--port=0"))).toThrow(/between 1 and 65535/);
    expect(() => parseArgs(argv("emulate", "--port=70000"))).toThrow(/between 1 and 65535/);
    expect(parseArgs(argv("emulate", "--port", "8080")).flags["port"]).toBe("8080");
  });
});
