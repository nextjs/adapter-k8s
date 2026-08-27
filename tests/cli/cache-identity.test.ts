import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/cli/exec.js");

import * as exec from "../../src/cli/exec.js";
import {
  claimManagedCacheIdentity,
  managedCacheIdentityName,
  readManagedCacheIdentity,
} from "../../src/cli/cache-identity.js";

const ok = (stdout = ""): exec.ExecCaptureResult => ({ exitCode: 0, stdout, stderr: "" });

function identity(projectId = "project-one", region = "us-central1") {
  return JSON.stringify({
    metadata: {
      labels: {
        "app.kubernetes.io/name": "my-app",
        "app.kubernetes.io/component": "managed-cache-identity",
        "adapter-k8s.dev/release": "my-app",
      },
    },
    data: { projectId, region },
  });
}

describe("managed cache identity coordination", () => {
  beforeEach(() => {
    vi.mocked(exec.execCapture).mockReset();
  });

  it("uses a release-scoped Kubernetes name", () => {
    expect(managedCacheIdentityName("my-app")).toBe("my-app-cache-identity");
    expect(managedCacheIdentityName("a".repeat(40))).toHaveLength(55);
  });

  it("claims an absent identity with an atomic ConfigMap create", async () => {
    vi.mocked(exec.execCapture)
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok("configmap/my-app-cache-identity\n"));

    await claimManagedCacheIdentity("my-app", "apps", {
      projectId: "project-one",
      region: "us-central1",
    });

    const create = vi.mocked(exec.execCapture).mock.calls[1]?.[1] ?? [];
    expect(create.slice(0, 3)).toEqual(["create", "configmap", "my-app-cache-identity"]);
    expect(create).toContain("--from-literal=projectId=project-one");
    expect(create).toContain("--from-literal=region=us-central1");
  });

  it("accepts an existing identity only when coordinates and ownership match", async () => {
    vi.mocked(exec.execCapture).mockResolvedValueOnce(ok(identity()));

    await claimManagedCacheIdentity("my-app", "default", {
      projectId: "project-one",
      region: "us-central1",
    });

    expect(vi.mocked(exec.execCapture)).toHaveBeenCalledTimes(1);
  });

  it("rejects a concurrent claim for different paid coordinates", async () => {
    vi.mocked(exec.execCapture)
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "AlreadyExists" })
      .mockResolvedValueOnce(ok(identity("project-two", "europe-west1")));

    await expect(
      claimManagedCacheIdentity("my-app", "default", {
        projectId: "project-one",
        region: "us-central1",
      }),
    ).rejects.toThrow(/already claims project-two\/europe-west1/);
  });

  it("rejects a foreign ConfigMap instead of treating it as infrastructure state", async () => {
    vi.mocked(exec.execCapture).mockResolvedValueOnce(
      ok(
        JSON.stringify({
          metadata: { labels: { "app.kubernetes.io/name": "someone-else" } },
          data: { projectId: "project-one", region: "us-central1" },
        }),
      ),
    );

    await expect(readManagedCacheIdentity("my-app", "default")).rejects.toThrow(
      /foreign or incomplete ownership/,
    );
  });
});
