import { execCapture, EXEC_TIMEOUTS } from "../cli/exec.js";
import {
  assertSafeGcpResourceName,
  assertSafeProjectId,
  assertSafeRegion,
} from "../emit/templates/utils.js";

interface Backend {
  name: string;
  region?: string;
  backends?: { group?: string }[];
}
export interface BackendRef {
  name: string;
  region?: string;
}

/** Read-only Compute access. The Job uses Workload Identity; the CLI uses its pinned project. */
export class GkeBackends {
  private token: string | undefined;
  private expires = 0;
  constructor(private readonly project: string) {
    assertSafeProjectId(project);
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.expires) return this.token;
    if (process.env.KUBERNETES_SERVICE_HOST) {
      const response = await fetch(
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
        {
          headers: { "Metadata-Flavor": "Google" },
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok)
        throw new Error(`GKE cutover identity token request failed (${response.status})`);
      const body = (await response.json()) as { access_token?: unknown; expires_in?: number };
      if (typeof body.access_token !== "string" || !body.access_token)
        throw new Error("Missing GKE cutover identity token");
      this.token = body.access_token;
    } else {
      const result = await execCapture(
        "gcloud",
        ["auth", "print-access-token", `--project=${this.project}`, "--quiet"],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      if (result.exitCode !== 0 || !result.stdout.trim())
        throw new Error("Could not authenticate GKE backend health checks");
      this.token = result.stdout.trim();
    }
    this.expires = Date.now() + 60_000;
    return this.token;
  }

  private async get(resource: string, query = ""): Promise<any> {
    const token = await this.accessToken();
    const response = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${this.project}/${resource}${query}`,
      {
        headers: { authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new Error(`GKE backend health API returned HTTP ${response.status}`);
    return response.json();
  }

  async discover(neg: string): Promise<BackendRef[]> {
    assertSafeGcpResourceName(neg, "NEG name");
    const found: BackendRef[] = [];
    let page: string | undefined;
    for (let count = 0; count < 100; count++) {
      const result = await this.get(
        "aggregated/backendServices",
        page ? `?pageToken=${encodeURIComponent(page)}` : "",
      );
      for (const scope of Object.values(result.items ?? {}) as { backendServices?: Backend[] }[]) {
        for (const backend of scope.backendServices ?? []) {
          const matches = backend.backends?.some(({ group }) => {
            if (typeof group !== "string") return false;
            const url = new URL(group);
            return (
              url.origin === "https://www.googleapis.com" &&
              url.pathname.startsWith(`/compute/v1/projects/${this.project}/zones/`) &&
              url.pathname.endsWith(`/networkEndpointGroups/${neg}`)
            );
          });
          if (!matches) continue;
          assertSafeGcpResourceName(backend.name, "backend service name");
          const region = backend.region?.split("/").at(-1);
          if (region) assertSafeRegion(region);
          found.push({ name: backend.name, ...(region ? { region } : {}) });
        }
      }
      page = result.nextPageToken;
      if (!page) return found;
    }
    throw new Error("GKE backend discovery exceeded its pagination budget");
  }

  async healthy(ref: BackendRef, neg: string): Promise<Set<string>> {
    assertSafeGcpResourceName(ref.name, "backend service name");
    assertSafeGcpResourceName(neg, "NEG name");
    if (ref.region) assertSafeRegion(ref.region);
    const scope = ref.region ? `regions/${ref.region}` : "global";
    const backend = await this.get(`${scope}/backendServices/${ref.name}`);
    const healthy = new Set<string>();
    // The chart's policy may still be propagating. Do not retire outgoing capacity
    // until the backend actually has connection draining enabled.
    if (!(backend.connectionDraining?.drainingTimeoutSec >= 60)) return healthy;
    for (const { group } of backend.backends ?? []) {
      if (typeof group !== "string") throw new Error("Invalid backend group");
      const url = new URL(group);
      if (
        url.origin !== "https://www.googleapis.com" ||
        !url.pathname.startsWith(`/compute/v1/projects/${this.project}/zones/`) ||
        !url.pathname.endsWith(`/networkEndpointGroups/${neg}`)
      )
        continue;
      const token = await this.accessToken();
      const response = await fetch(
        `https://compute.googleapis.com/compute/v1/projects/${this.project}/${scope}/backendServices/${ref.name}/getHealth`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ group }),
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) throw new Error(`GKE backend health API returned HTTP ${response.status}`);
      const body = (await response.json()) as {
        healthStatus?: { ipAddress?: string; port?: number; healthState?: string }[];
      };
      for (const endpoint of body.healthStatus ?? []) {
        if (endpoint.healthState === "HEALTHY" && endpoint.port === 3000 && endpoint.ipAddress)
          healthy.add(endpoint.ipAddress);
      }
    }
    return healthy;
  }
}
