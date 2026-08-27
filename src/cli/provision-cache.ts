// Managed cache provisioning: a Memorystore instance (Redis engine — wire-compatible with
// the pool's zero-dep RESP2 client, same as Valkey) reachable privately from the GKE pods.
// Used when `cache.enabled` is set without a BYO `cache.url`. The instance's endpoint is
// injected into the pods via the `${releaseName}-valkey` Secret, which deploy renders into
// the chart (Helm-owned) once provisioning reveals the private IP.
import { EXEC_TIMEOUTS, execCapture } from "./exec.js";
import {
  assertSafeProjectId,
  assertSafeRegion,
  assertSafeReleaseName,
} from "../emit/templates/utils.js";

const GCP_NETWORK_NAME_RE = /^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/;

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

interface InstanceConfiguration {
  authEnabled: boolean;
  transitEncryptionMode: string;
  memorySizeGb: number;
  tier: string;
  authorizedNetwork: string;
  connectMode: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function describeInstance(
  name: string,
  region: string,
  projectId: string,
): Promise<InstanceInfo | null> {
  const res = await execCapture(
    "gcloud",
    [
      "redis",
      "instances",
      "describe",
      name,
      "--region",
      region,
      "--project",
      projectId,
      "--format=value(state,host,port)",
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
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

// Existing instances are paid, stateful infrastructure. Reuse is safe only when every
// plan-controlled setting agrees; silently accepting drift makes the signed composition plan a
// description of intent instead of an authorization boundary.
async function describeInstanceConfiguration(
  name: string,
  region: string,
  projectId: string,
): Promise<InstanceConfiguration | null> {
  const res = await execCapture(
    "gcloud",
    [
      "redis",
      "instances",
      "describe",
      name,
      "--region",
      region,
      "--project",
      projectId,
      "--format=json(authEnabled,transitEncryptionMode,memorySizeGb,tier,authorizedNetwork,connectMode)",
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  if (res.exitCode !== 0 || !res.stdout.trim()) return null;
  try {
    const parsed = JSON.parse(res.stdout) as {
      authEnabled?: boolean;
      transitEncryptionMode?: string;
      memorySizeGb?: number | string;
      tier?: string;
      authorizedNetwork?: string;
      connectMode?: string;
    };
    const memorySizeGb =
      typeof parsed.memorySizeGb === "number"
        ? parsed.memorySizeGb
        : typeof parsed.memorySizeGb === "string" && /^\d+$/.test(parsed.memorySizeGb)
          ? Number(parsed.memorySizeGb)
          : Number.NaN;
    if (
      typeof parsed.authEnabled !== "boolean" ||
      typeof parsed.transitEncryptionMode !== "string" ||
      !Number.isInteger(memorySizeGb) ||
      typeof parsed.tier !== "string" ||
      typeof parsed.authorizedNetwork !== "string" ||
      typeof parsed.connectMode !== "string"
    ) {
      return null;
    }
    return {
      authEnabled: parsed.authEnabled,
      transitEncryptionMode: parsed.transitEncryptionMode,
      memorySizeGb,
      tier: parsed.tier,
      authorizedNetwork: parsed.authorizedNetwork,
      connectMode: parsed.connectMode,
    };
  } catch {
    return null;
  }
}

// Fetch the instance AUTH string. Requires redis.instances.getAuthString, which the
// deployer (who created the instance) has.
async function fetchAuthString(name: string, region: string, projectId: string): Promise<string> {
  const res = await execCapture(
    "gcloud",
    [
      "redis",
      "instances",
      "get-auth-string",
      name,
      "--region",
      region,
      "--project",
      projectId,
      "--format=value(authString)",
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
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
  const res = await execCapture(
    "gcloud",
    [
      "redis",
      "instances",
      "describe",
      name,
      "--region",
      region,
      "--project",
      projectId,
      "--format=json(serverCaCerts)",
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
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
  assertSafeProjectId(projectId);
  assertSafeRegion(region);
  assertSafeReleaseName(releaseName);
  if (!GCP_NETWORK_NAME_RE.test(network)) {
    throw new Error(
      `Invalid Memorystore network ${JSON.stringify(network)}: expected a GCP network name`,
    );
  }
  if (!Number.isInteger(sizeGb) || sizeGb < 1 || sizeGb > 300) {
    throw new Error("Memorystore sizeGb must be an integer from 1 to 300");
  }
  if (tier !== undefined && tier !== "BASIC" && tier !== "STANDARD_HA") {
    throw new Error('Memorystore tier must be "BASIC" or "STANDARD_HA"');
  }
  if (auth !== undefined && typeof auth !== "boolean") {
    throw new Error("Memorystore auth must be a boolean");
  }
  const name = cacheInstanceName(releaseName);

  // S8 (SECURITY). AUTH + in-transit encryption now default ON. Memorystore's own defaults are
  // authEnabled=false / transitEncryption=disabled, so the previous `auth = false` handed every
  // deployment a plaintext, unauthenticated cache reachable by any workload with VPC
  // reachability — and the emitted NetworkPolicies are Ingress-only, so nothing constrained
  // that path. From there a compromised sibling workload can enumerate `k8s:<buildId>:` keys,
  // overwrite cached HTML/RSC (content injection into the production site) or drop tags
  // wholesale. Only a `// Recommended` comment in types.ts documented the risk.
  //
  // AUTH is creation-only. Unset means secure; explicit false is the only plaintext opt-out.
  // Existing infrastructure must match exactly in either direction: returning a plaintext URL
  // for an AUTH-only instance is just as broken as returning rediss:// for a plaintext one.
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
  await execCapture(
    "gcloud",
    ["services", "enable", "redis.googleapis.com", "--project", projectId, "--quiet"],
    { timeoutMs: EXEC_TIMEOUTS.cloudOperation },
  );

  // Attach the AUTH string + CA to a ready endpoint when AUTH mode is on.
  const withAuth = async (
    endpoint: CacheEndpoint,
    hasAuth = wantAuthOnCreate,
  ): Promise<CacheEndpoint> => {
    if (!hasAuth) return endpoint;
    const [authString, caCert] = await Promise.all([
      fetchAuthString(name, region, projectId),
      fetchServerCaCert(name, region, projectId),
    ]);
    return { ...endpoint, authString, caCert };
  };

  const expectedTier = tier ?? "BASIC";
  const verifyExistingConfiguration = async (): Promise<boolean> => {
    const details = await describeInstanceConfiguration(name, region, projectId);
    if (!details) {
      throw new Error(
        `Could not verify the full configuration of the existing Memorystore instance ${name} ` +
          `(gcloud describe failed or returned incomplete data). Refusing to reuse paid state ` +
          `without proving it matches the authenticated cache plan.`,
      );
    }

    const expectedNetwork = `projects/${projectId}/global/networks/${network}`;
    const existingNetwork = details.authorizedNetwork
      .replace(/^https?:\/\/[^/]+\/compute\/v1\//, "")
      .replace(/^\/+/, "");
    const secured =
      details.authEnabled && details.transitEncryptionMode === "SERVER_AUTHENTICATION";
    const securityMatches = wantAuthOnCreate
      ? secured
      : !details.authEnabled && details.transitEncryptionMode === "DISABLED";
    const mismatches: string[] = [];
    if (details.memorySizeGb !== sizeGb) {
      mismatches.push(`memorySizeGb expected ${sizeGb}, found ${details.memorySizeGb}`);
    }
    if (details.tier !== expectedTier) {
      mismatches.push(`tier expected ${expectedTier}, found ${details.tier}`);
    }
    if (existingNetwork !== expectedNetwork) {
      mismatches.push(`network expected ${expectedNetwork}, found ${details.authorizedNetwork}`);
    }
    if (details.connectMode !== "DIRECT_PEERING") {
      mismatches.push(`connectMode expected DIRECT_PEERING, found ${details.connectMode}`);
    }
    if (!securityMatches) {
      mismatches.push(
        `security expected ${wantAuthOnCreate ? "AUTH + TLS" : "plaintext"}, found ` +
          `authEnabled=${String(details.authEnabled)}, ` +
          `transitEncryptionMode=${details.transitEncryptionMode}`,
      );
    }
    if (mismatches.length > 0) {
      throw new Error(
        `Existing Memorystore instance ${name} is incompatible with the authenticated cache ` +
          `plan: ${mismatches.join("; ")}. Recreate it intentionally or restore matching ` +
          `configuration; refusing to reuse or mutate paid state.`,
      );
    }
    return secured;
  };

  const existing = await describeInstance(name, region, projectId);
  if (existing) {
    const secured = await verifyExistingConfiguration();
    if (existing.state === "READY" && existing.host) {
      log(`    Reusing Memorystore ${name} at ${existing.host}:${existing.port}`);
      return withAuth({ host: existing.host, port: existing.port }, secured);
    }
    log(`    Memorystore ${name} exists (state=${existing.state}); waiting for READY…`);
    return withAuth(await waitForReady(name, region, projectId, log), secured);
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
  if (create.exitCode !== 0) {
    // A concurrent creator may use a different plan. The name collision is not evidence that
    // its paid instance is safe for this deployment.
    await verifyExistingConfiguration();
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
