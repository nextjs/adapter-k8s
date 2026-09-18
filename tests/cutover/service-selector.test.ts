import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/cli/exec.js");
vi.mock("../../src/cutover/gke-backends.js");
import { execCapture } from "../../src/cli/exec.js";
import { GkeBackends } from "../../src/cutover/gke-backends.js";
import { replaceServiceSelector } from "../../src/cutover/service-selector.js";

const original = {
  "app.kubernetes.io/name": "app",
  "app.kubernetes.io/component": "web",
  "app.kubernetes.io/version": "old",
};
const next = { ...original, "app.kubernetes.io/version": "new" };
const annotations = {
  "cloud.google.com/neg-status": JSON.stringify({
    network_endpoint_groups: { "3000": "fixture-neg" },
  }),
};
const opts = {
  namespace: "default",
  service: "app-web",
  original,
  next,
  annotations,
  projectId: "my-project",
};
const oldPod = {
  metadata: { name: "old-pod", uid: "old-uid" },
  status: { podIP: "10.0.0.1", conditions: [{ type: "Ready", status: "True" }] },
};
const newPod = {
  metadata: { name: "new-pod", uid: "new-uid" },
  status: { podIP: "10.0.0.2", conditions: [{ type: "Ready", status: "True" }] },
};
let selector: Record<string, string>;
let patches: Record<string, string>[];
let labels: Map<string, Set<string>>;
let health: ReturnType<typeof vi.fn>;
let failFinal: boolean;
let failRestore: boolean;
let missingPod: boolean;
let recovery: string | undefined;
let loseFinalResponse: boolean;
const ok = (value: unknown = "") => ({
  exitCode: 0,
  stdout: typeof value === "string" ? value : JSON.stringify(value),
  stderr: "",
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  selector = { ...original };
  patches = [];
  labels = new Map();
  failFinal = false;
  failRestore = false;
  missingPod = false;
  recovery = undefined;
  loseFinalResponse = false;
  health = vi.fn().mockResolvedValue(new Set(["10.0.0.2"]));
  vi.mocked(GkeBackends).mockImplementation(
    class {
      discover = vi.fn().mockResolvedValue([{ name: "backend" }]);
      healthy = health;
    } as any,
  );
  vi.mocked(execCapture).mockImplementation(async (_cmd, args) => {
    if (args[0] === "get" && args[1] === "pods") {
      const target = args[args.indexOf("-l") + 1]!.includes("version=new");
      return ok({ items: target ? (missingPod ? [] : [newPod]) : [oldPod] });
    }
    if (args[0] === "get" && args[1] === "service") return ok({ spec: { selector } });
    const patch = JSON.parse(args[args.indexOf("-p") + 1]!);
    if (args[1] === "pod") {
      const name = args[2]!;
      expect(patch[0]).toEqual({
        op: "test",
        path: "/metadata/uid",
        value: name === "old-pod" ? "old-uid" : "new-uid",
      });
      const operation = patch.at(-1);
      const set = labels.get(name) ?? new Set<string>();
      if (operation.op === "add") set.add(operation.path);
      else set.delete(operation.path);
      labels.set(name, set);
      return ok();
    }
    expect(patch[0]).toEqual({ op: "test", path: "/spec/selector", value: selector });
    const proposed = patch[1].value;
    if (
      (failFinal && proposed["app.kubernetes.io/version"] === "new") ||
      (failRestore && proposed["app.kubernetes.io/version"] === "old")
    )
      return { exitCode: 1, stdout: "", stderr: "patch failed" };
    selector = proposed;
    for (const operation of patch.slice(2)) {
      expect(operation.path).toBe("/metadata/annotations/adapter-k8s.io~1backend-warmup");
      if (operation.op === "add") recovery = operation.value;
      else if (operation.op === "test") expect(recovery).toBe(operation.value);
      else if (operation.op === "remove") recovery = undefined;
    }
    patches.push(proposed);
    if (loseFinalResponse && proposed["app.kubernetes.io/version"] === "new")
      return { exitCode: 1, stdout: "", stderr: "response lost after applying patch" };
    return ok();
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GKE Service cutover", () => {
  it("retains old endpoints until incoming backend health is stable, then removes temporary labels", async () => {
    const result = replaceServiceSelector(opts);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(patches).toHaveLength(1);
    expect(selector["app.kubernetes.io/version"]).toBeUndefined();
    const key = Object.keys(selector).find((k) => k.startsWith("adapter-k8s.io/warm-"))!;
    expect(key).toBeTruthy();
    expect(JSON.parse(recovery!)).toEqual({ original, next, label: key });
    expect(labels.get("old-pod")!.size).toBe(1);
    expect(labels.get("new-pod")!.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).exitCode).toBe(0);
    expect(selector).toEqual(next);
    expect(recovery).toBeUndefined();
    expect([...labels.values()].every((s) => s.size === 0)).toBe(true);
  });

  it("resets the propagation interval when any attached backend loses health", async () => {
    health.mockResolvedValueOnce(new Set(["10.0.0.2"])).mockResolvedValueOnce(new Set());
    const result = replaceServiceSelector(opts);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(patches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await result).exitCode).toBe(0);
  });

  it("restores the exact old selector on a bounded health timeout", async () => {
    health.mockResolvedValue(new Set());
    const result = replaceServiceSelector(opts);
    await vi.advanceTimersByTimeAsync(300_000);
    expect((await result).exitCode).toBe(1);
    expect(selector).toEqual(original);
    expect(recovery).toBeUndefined();
    expect([...labels.values()].every((s) => s.size === 0)).toBe(true);
  });

  it("restores the selector when the final patch fails", async () => {
    failFinal = true;
    const result = replaceServiceSelector(opts);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await result).exitCode).toBe(1);
    expect(selector).toEqual(original);
  });

  it("keeps labels and capacity if recovery cannot safely restore the selector", async () => {
    failFinal = true;
    failRestore = true;
    const result = replaceServiceSelector(opts);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await result).stderr).toContain("both builds in place");
    expect([...labels.values()].every((s) => s.size === 1)).toBe(true);
    expect(selector["app.kubernetes.io/version"]).toBeUndefined();
    expect(JSON.parse(recovery!).original).toEqual(original);
  });

  it("reads back a final patch with a lost response and restores the outgoing selector", async () => {
    loseFinalResponse = true;
    const result = replaceServiceSelector(opts);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await result).exitCode).toBe(1);
    expect(selector).toEqual(original);
    expect(recovery).toBeUndefined();
    expect([...labels.values()].every((s) => s.size === 0)).toBe(true);
  });

  it("aborts if a verified incoming pod disappears during warm-up", async () => {
    const result = replaceServiceSelector(opts);
    await vi.advanceTimersByTimeAsync(1);
    missingPod = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await result).stderr).toContain("Incoming pod set changed");
    expect(selector).toEqual(original);
  });

  it("fails closed without cloud identity before mutating endpoints", async () => {
    expect((await replaceServiceSelector({ ...opts, projectId: undefined })).exitCode).toBe(1);
    expect(execCapture).not.toHaveBeenCalled();
  });

  it("leaves generic Service cutovers as a single selector CAS", async () => {
    expect((await replaceServiceSelector({ ...opts, annotations: {} })).exitCode).toBe(0);
    expect(execCapture).toHaveBeenCalledTimes(1);
    expect(selector).toEqual(next);
    expect(GkeBackends).not.toHaveBeenCalled();
  });
});
