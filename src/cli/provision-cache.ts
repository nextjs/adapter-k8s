// Managed cache provisioning: a Memorystore instance (Redis engine — wire-compatible with
// the pool's zero-dep RESP2 client, same as Valkey) reachable privately from the GKE pods.
// Used when `cache.enabled` is set without a BYO `cache.url`. The instance's endpoint is
// injected into the pods via the `${releaseName}-valkey` Secret, which deploy renders into
// the chart (Helm-owned) once provisioning reveals the private IP.
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
  /**
   * Enable Redis AUTH + in-transit encryption (SERVER_AUTHENTICATION). The endpoint then
   * requires `rediss://` + the instance AUTH string + server CA, returned on the result.
   * Creation-only on Memorystore — an existing non-AUTH instance is rejected with guidance.
   */
  auth?: boolean;
  dryRun?: boolean;
  log?: (msg: string) => void;
}

export interface CacheEndpoint {
  host: string;
  port: number;
  /** Instance AUTH string — present only when `auth: true`. */
  authString?: string;
  /** PEM of the instance's server CA (in-transit encryption) — present only when `auth: true`. */
  caCert?: string;
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

// Full instance details, needed when AUTH is requested: AUTH + in-transit encryption are
// creation-only on Memorystore, so an existing instance must already have them enabled.
async function describeInstanceAuth(
  name: string,
  region: string,
  projectId: string,
): Promise<{ authEnabled: boolean; transitEncryption: boolean } | null> {
  const res = await execCapture("gcloud", [
    "redis",
    "instances",
    "describe",
    name,
    "--region",
    region,
    "--project",
    projectId,
    "--format=json(authEnabled,transitEncryptionMode)",
  ]);
  if (res.exitCode !== 0 || !res.stdout.trim()) return null;
  try {
    const parsed = JSON.parse(res.stdout) as {
      authEnabled?: boolean;
      transitEncryptionMode?: string;
    };
    return {
      authEnabled: parsed.authEnabled === true,
      transitEncryption: parsed.transitEncryptionMode === "SERVER_AUTHENTICATION",
    };
  } catch {
    return null;
  }
}

// Fetch the instance AUTH string. Requires redis.instances.getAuthString, which the
// deployer (who created the instance) has.
async function fetchAuthString(name: string, region: string, projectId: string): Promise<string> {
  const res = await execCapture("gcloud", [
    "redis",
    "instances",
    "get-auth-string",
    name,
    "--region",
    region,
    "--project",
    projectId,
    "--format=value(authString)",
  ]);
  const auth = res.stdout.trim();
  if (res.exitCode !== 0 || !auth) {
    throw new Error(
      `Failed to read the AUTH string for Memorystore instance ${name}: ${res.stderr.trim()}`,
    );
  }
  return auth;
}

// Fetch the PEM of the instance's server CA for in-transit encryption. The pool pins TLS to
// this CA — Memorystore certs are not publicly rooted, so default trust stores reject them.
async function fetchServerCaCert(name: string, region: string, projectId: string): Promise<string> {
  const res = await execCapture("gcloud", [
    "redis",
    "instances",
    "describe",
    name,
    "--region",
    region,
    "--project",
    projectId,
    "--format=json(serverCaCerts)",
  ]);
  if (res.exitCode !== 0) {
    throw new Error(
      `Failed to read the server CA for Memorystore instance ${name}: ${res.stderr.trim()}`,
    );
  }
  try {
    const parsed = JSON.parse(res.stdout) as { serverCaCerts?: { cert?: string }[] };
    const cert = parsed.serverCaCerts?.find((c) => typeof c.cert === "string" && c.cert)?.cert;
    if (!cert) throw new Error("no cert in response");
    return cert;
  } catch (err) {
    throw new Error(
      `Failed to parse the server CA for Memorystore instance ${name}: ${(err as Error).message}`,
    );
  }
}

/**
 * Idempotently provision the managed cache instance and return its private endpoint. Reuses an
 * existing instance (keyed by release name), waiting for READY if a prior run left it mid-create.
 * With `auth: true`, the instance is created with Redis AUTH + in-transit encryption and the
 * result carries the AUTH string + server CA for the pods' `rediss://` connection.
 */
export async function provisionMemorystore(opts: ProvisionCacheOptions): Promise<CacheEndpoint> {
  const {
    projectId,
    region,
    releaseName,
    network = "default",
    sizeGb = 1,
    tier,
    auth,
    dryRun,
    log = console.log,
  } = opts;
  const name = cacheInstanceName(releaseName);

  // S8 (SECURITY). AUTH + in-transit encryption now default ON. Memorystore's own defaults are
  // authEnabled=false / transitEncryption=disabled, so the previous `auth = false` handed every
  // deployment a plaintext, unauthenticated cache reachable by any workload with VPC
  // reachability — and the emitted NetworkPolicies are Ingress-only, so nothing constrained
  // that path. From there a compromised sibling workload can enumerate `k8s:<buildId>:` keys,
  // overwrite cached HTML/RSC (content injection into the production site) or drop tags
  // wholesale. Only a `// Recommended` comment in types.ts documented the risk.
  //
  // Three states, because AUTH is CREATION-ONLY and an existing instance cannot be retrofitted:
  //  - explicit `true`  → require it; refuse to reuse an instance that lacks it (unchanged).
  //  - unset (default)  → create WITH it, but tolerate a pre-existing instance that lacks it
  //                       (loudly). Otherwise the new default would hard-fail every existing
  //                       deployment on upgrade and demand a cache wipe, which is not a
  //                       migration this change is entitled to force.
  //  - explicit `false` → opt out, and say so on every deploy.
  const authExplicit = auth === true;
  const authOptedOut = auth === false;
  const wantAuthOnCreate = !authOptedOut;
  if (authOptedOut) {
    log(
      `    ! cache.memorystore.auth is explicitly false — the instance will accept UNAUTHENTICATED, ` +
        `unencrypted connections from anything that can reach it on the VPC. Any workload there ` +
        `can read every cached page and overwrite cache entries.`,
    );
  }

  if (dryRun) {
    log(
      `    [dry-run] provision Memorystore ${name} (${sizeGb}GB, ${region}, network ${network}` +
        `${wantAuthOnCreate ? ", AUTH + in-transit encryption" : ""})`,
    );
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

  // Attach the AUTH string + CA to a ready endpoint when AUTH mode is on.
  const withAuth = async (endpoint: CacheEndpoint, hasAuth = wantAuthOnCreate): Promise<CacheEndpoint> => {
    if (!hasAuth) return endpoint;
    const [authString, caCert] = await Promise.all([
      fetchAuthString(name, region, projectId),
      fetchServerCaCert(name, region, projectId),
    ]);
    return { ...endpoint, authString, caCert };
  };

  const existing = await describeInstance(name, region, projectId);
  if (existing) {
    // AUTH + in-transit encryption are creation-only: refuse to silently reuse an instance
    // that doesn't enforce them (the pods would get a rediss:// endpoint they can't use, or
    // worse, plaintext creds would be expected on a path the operator believes is secured).
    if (wantAuthOnCreate) {
      const details = await describeInstanceAuth(name, region, projectId);
      // "Couldn't tell" is NOT "proceed": a null here means the describe failed (or
      // returned nothing parseable), and reusing the instance blind could hand the pods a
      // rediss:// endpoint on an instance that doesn't enforce AUTH. Abort with guidance.
      if (!details) {
        throw new Error(
          `Could not verify the AUTH / in-transit-encryption posture of the existing ` +
            `Memorystore instance ${name} (gcloud describe failed or returned nothing). ` +
            `AUTH is creation-only, so refusing to guess. Check \`gcloud redis instances ` +
            `describe ${name} --region ${region} --project ${projectId}\` and re-run the deploy.`,
        );
      }
      const secured = details.authEnabled && details.transitEncryption;
      if (!secured && authExplicit) {
        throw new Error(
          `Memorystore instance ${name} already exists WITHOUT AUTH / in-transit encryption, ` +
            `but cache.memorystore.auth is enabled. AUTH can only be set at creation: either ` +
            `delete the instance (\`adapter-k8s destroy\` removes it) and redeploy, or set ` +
            `cache.memorystore.auth: false.`,
        );
      }
      if (!secured) {
        // S8: pre-existing instance from before AUTH became the default. Continue rather than
        // demand a cache wipe, but never quietly — this is a live exposure, and the operator
        // is the only one who can schedule the recreate that fixes it.
        log(
          `    ! Memorystore ${name} predates the AUTH default and has AUTH / in-transit ` +
            `encryption DISABLED (creation-only, so it cannot be enabled in place). Any ` +
            `workload that can reach it on the VPC can read and overwrite the shared cache. ` +
            `To fix: \`adapter-k8s destroy\` the instance and redeploy, which recreates it ` +
            `with AUTH. To silence this, set cache.memorystore.auth: false.`,
        );
      }
      if (existing.state === "READY" && existing.host) {
        log(`    Reusing Memorystore ${name} at ${existing.host}:${existing.port}`);
        return withAuth({ host: existing.host, port: existing.port }, secured);
      }
      log(`    Memorystore ${name} exists (state=${existing.state}); waiting for READY…`);
      return withAuth(await waitForReady(name, region, projectId, log), secured);
    }
    if (existing.state === "READY" && existing.host) {
      log(`    Reusing Memorystore ${name} at ${existing.host}:${existing.port}`);
      return withAuth({ host: existing.host, port: existing.port });
    }
    log(`    Memorystore ${name} exists (state=${existing.state}); waiting for READY…`);
    return withAuth(await waitForReady(name, region, projectId, log));
  }

  const gcpTier = (tier ?? "").toUpperCase() === "STANDARD_HA" ? "standard_ha" : "basic";
  log(
    `    Creating Memorystore ${name} (${sizeGb}GB, tier ${gcpTier}` +
      `${wantAuthOnCreate ? ", AUTH + in-transit encryption" : ""}) — this takes a few minutes…`,
  );
  const create = await execCapture(
    "gcloud",
    [
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
      ...(wantAuthOnCreate
        ? ["--auth-enabled", "--transit-encryption-mode", "SERVER_AUTHENTICATION"]
        : []),
      "--project",
      projectId,
      "--quiet",
    ],
    // Instance creation waits on a long-running GCP operation (typically 5-15 min);
    // without a cap a wedged operation would hang the deploy forever.
    { timeoutMs: 20 * 60 * 1000 },
  );
  if (create.exitCode !== 0 && !/already exists/i.test(create.stderr)) {
    // A concurrent run may have created it first ("already exists") — in that case fall through
    // to wait for READY rather than failing the deploy.
    throw new Error(`Failed to create Memorystore instance ${name}: ${create.stderr.trim()}`);
  }
  const ready = await waitForReady(name, region, projectId, log);
  log(`    Memorystore ${name} ready at ${ready.host}:${ready.port}`);
  return withAuth(ready);
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
