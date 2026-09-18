import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/cli/exec.js");
import { execCapture } from "../../src/cli/exec.js";
import { GkeBackends } from "../../src/cutover/gke-backends.js";

const group =
  "https://www.googleapis.com/compute/v1/projects/my-project/zones/us-central1-a/networkEndpointGroups/fixture-neg";
const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("KUBERNETES_SERVICE_HOST", "");
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(execCapture).mockResolvedValue({ exitCode: 0, stdout: "test-token\n", stderr: "" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("GKE backend health access", () => {
  it("discovers only the exact project and NEG across pages and scopes", async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        items: {
          global: {
            backendServices: [
              { name: "global-backend", backends: [{ group }] },
              {
                name: "foreign",
                backends: [{ group: group.replace("my-project", "another-project") }],
              },
            ],
          },
        },
        nextPageToken: "page/+2",
      }),
    );
    fetchMock.mockResolvedValueOnce(
      json({
        items: {
          "regions/us-central1": {
            backendServices: [
              {
                name: "regional-backend",
                region:
                  "https://www.googleapis.com/compute/v1/projects/my-project/regions/us-central1",
                backends: [{ group }],
              },
            ],
          },
        },
      }),
    );
    expect(await new GkeBackends("my-project").discover("fixture-neg")).toEqual([
      { name: "global-backend" },
      { name: "regional-backend", region: "us-central1" },
    ]);
    expect(fetchMock.mock.calls[1]![0]).toContain("pageToken=page%2F%2B2");
    expect(execCapture).toHaveBeenCalledWith(
      "gcloud",
      ["auth", "print-access-token", "--project=my-project", "--quiet"],
      expect.anything(),
    );
    expect(fetchMock.mock.calls[0]![1].headers.authorization).toBe("Bearer test-token");
  });

  it("requires draining and reports only healthy endpoints on the application port", async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        connectionDraining: { drainingTimeoutSec: 60 },
        backends: [{ group }, { group: group.replace("fixture-neg", "different-neg") }],
      }),
    );
    fetchMock.mockResolvedValueOnce(
      json({
        healthStatus: [
          { healthState: "HEALTHY", port: 3000, ipAddress: "10.0.0.1" },
          { healthState: "UNHEALTHY", port: 3000, ipAddress: "10.0.0.2" },
          { healthState: "HEALTHY", port: 3001, ipAddress: "10.0.0.3" },
        ],
      }),
    );
    expect(
      await new GkeBackends("my-project").healthy(
        { name: "backend", region: "us-central1" },
        "fixture-neg",
      ),
    ).toEqual(new Set(["10.0.0.1"]));
    expect(fetchMock.mock.calls[1]![0]).toContain(
      "/regions/us-central1/backendServices/backend/getHealth",
    );
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ group }),
      redirect: "error",
    });
  });

  it("does not declare health while the drain policy is still unapplied", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ connectionDraining: { drainingTimeoutSec: 0 }, backends: [{ group }] }),
    );
    expect(await new GkeBackends("my-project").healthy({ name: "backend" }, "fixture-neg")).toEqual(
      new Set(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses Workload Identity in the cutover Job without putting a token on argv", async () => {
    vi.stubEnv("KUBERNETES_SERVICE_HOST", "10.0.0.1");
    fetchMock
      .mockResolvedValueOnce(json({ access_token: "job-token", expires_in: 3600 }))
      .mockResolvedValueOnce(json({ items: {} }));
    await new GkeBackends("my-project").discover("fixture-neg");
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    );
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      headers: { "Metadata-Flavor": "Google" },
      redirect: "error",
    });
    expect(execCapture).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[1]![1].headers.authorization).toBe("Bearer job-token");
  });

  it("fails closed on auth errors without copying secret-bearing output into errors", async () => {
    vi.mocked(execCapture).mockResolvedValue({
      exitCode: 1,
      stdout: "private-output",
      stderr: "private-error",
    });
    await expect(new GkeBackends("my-project").discover("fixture-neg")).rejects.toThrow(
      "Could not authenticate",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid identities before making an authenticated request", async () => {
    expect(() => new GkeBackends("../other-project")).toThrow();
    await expect(
      new GkeBackends("my-project").healthy({ name: "../backend" }, "fixture-neg"),
    ).rejects.toThrow();
    expect(execCapture).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
