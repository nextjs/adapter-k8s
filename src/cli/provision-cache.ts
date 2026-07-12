// Managed cache provisioning: a Memorystore instance (Redis engine — wire-compatible with the
// ioredis client the pool uses, same as Valkey) reachable privately from the GKE pods. Used
// when `cache.enabled` is set without a BYO `cache.url`. The instance's endpoint is injected
// into the pods via the `${releaseName}-valkey` Secret (created imperatively at deploy time,
// since the private IP is only known after provisioning).
import { execCapture } from "./exec.js";

export interface ProvisionCacheOptions {
  projectId: string;
  region: string;
  releaseName: string;
  /** VPC the cluster runs on. Defaults to "default". */
  network?: string;
  /** Instance memory size in GB. Defaults to 1. */
  sizeGb?: number;
  /** Service tier from config ("BASIC" | "STANDARD_HA"). Defaults to basic. */
  tier?: string;
  dryRun?: boolean;
  log?: (msg: string) => void;
}

export interface CacheEndpoint {
  host: string;
  port: number;
}

/** Deterministic instance name, so provisioning is idempotent across deploys. */
export function cacheInstanceName(releaseName: string): string {
  return `${releaseName}-cache`;
}

interface InstanceInfo {
  state: string;
  host: string;
  port: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function describeInstance(
  name: string,
  region: string,
  projectId: string,
): Promise<InstanceInfo | null> {
  const res = await execCapture("gcloud", [
    "redis",
    "instances",
    "describe",
    name,
    "--region",
    region,
    "--project",
    projectId,
    "--format=value(state,host,port)",
  ]);
  if (res.exitCode !== 0) return null; // not found (or transient API error)
  const out = res.stdout.trim();
  if (!out) return null;
  const [state, host, port] = out.split(/\s+/);
  return { state: state ?? "", host: host ?? "", port: port ? parseInt(port, 10) : 6379 };
}

async function waitForReady(
  name: string,
  region: string,
  projectId: string,
  log: (m: string) => void,
): Promise<CacheEndpoint> {
  // Covers reuse of an instance still CREATING from a prior/interrupted run — `gcloud create`
  // already blocks until READY in the common path.
  for (let i = 0; i < 90; i++) {
    const info = await describeInstance(name, region, projectId);
    if (info && info.state === "READY" && info.host) return { host: info.host, port: info.port };
    log(`    Memorystore ${name} state=${info?.state ?? "?"} — waiting for READY…`);
    await sleep(10_000);
  }
  throw new Error(`Memorystore ${name} did not reach READY in time`);
}

/**
 * Idempotently provision the managed cache instance and return its private endpoint. Reuses an
 * existing instance (keyed by release name), waiting for READY if a prior run left it mid-create.
 */
export async function provisionMemorystore(opts: ProvisionCacheOptions): Promise<CacheEndpoint> {
  const {
    projectId,
    region,
    releaseName,
    network = "default",
    sizeGb = 1,
    tier,
    dryRun,
    log = console.log,
  } = opts;
  const name = cacheInstanceName(releaseName);

  if (dryRun) {
    log(`    [dry-run] provision Memorystore ${name} (${sizeGb}GB, ${region}, network ${network})`);
    return { host: "0.0.0.0", port: 6379 };
  }

  log("    Ensuring redis.googleapis.com is enabled…");
  await execCapture("gcloud", [
    "services",
    "enable",
    "redis.googleapis.com",
    "--project",
    projectId,
    "--quiet",
  ]);

  const existing = await describeInstance(name, region, projectId);
  if (existing) {
    if (existing.state === "READY" && existing.host) {
      log(`    Reusing Memorystore ${name} at ${existing.host}:${existing.port}`);
      return { host: existing.host, port: existing.port };
    }
    log(`    Memorystore ${name} exists (state=${existing.state}); waiting for READY…`);
    return waitForReady(name, region, projectId, log);
  }

  const gcpTier = (tier ?? "").toUpperCase() === "STANDARD_HA" ? "standard_ha" : "basic";
  log(`    Creating Memorystore ${name} (${sizeGb}GB, tier ${gcpTier}) — this takes a few minutes…`);
  const create = await execCapture("gcloud", [
    "redis",
    "instances",
    "create",
    name,
    "--size",
    String(sizeGb),
    "--region",
    region,
    "--network",
    network,
    "--tier",
    gcpTier,
    "--connect-mode",
    "DIRECT_PEERING",
    "--project",
    projectId,
    "--quiet",
  ]);
  if (create.exitCode !== 0 && !/already exists/i.test(create.stderr)) {
    // A concurrent run may have created it first ("already exists") — in that case fall through
    // to wait for READY rather than failing the deploy.
    throw new Error(`Failed to create Memorystore instance ${name}: ${create.stderr.trim()}`);
  }
  const ready = await waitForReady(name, region, projectId, log);
  log(`    Memorystore ${name} ready at ${ready.host}:${ready.port}`);
  return ready;
}

/** A release-scoped delete command for the cache instance (for `destroy`). */
export function buildDeleteMemorystoreCommand(
  releaseName: string,
  region: string,
  projectId: string,
): { desc: string; command: string; args: string[] } {
  return {
    desc: `Memorystore instance "${cacheInstanceName(releaseName)}"`,
    command: "gcloud",
    args: [
      "redis",
      "instances",
      "delete",
      cacheInstanceName(releaseName),
      "--region",
      region,
      "--project",
      projectId,
      "--quiet",
    ],
  };
}
