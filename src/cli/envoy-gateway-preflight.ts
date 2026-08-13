// src/cli/envoy-gateway-preflight.ts
//
// Soft (never-failing) Envoy Gateway compatibility checks, grounded in the live
// 2026-08 compat verification run (Envoy Gateway v1.5.4/v1.5.5/v1.8.3 against the
// full adapter surface: envoyNativeRouting ext_proc, ClientTrafficPolicy, deploy
// gates, cutover, rollback). Two findings from that run drive this module:
//
//  1. The adapter's emitted resources work unmodified across v1.5.4–v1.8.3, so a
//     controller OUTSIDE the verified range >=1.5.4 <1.9 gets a WARN — never a
//     failure — because nothing is known to be broken, only unverified.
//  2. The real 1.5→1.8 break is install-order, not schema: `helm upgrade` never
//     touches the chart's crds/ subchart, and Envoy Gateway >= 1.8 unconditionally
//     watches ListenerSet (`listenersets.gateway.networking.k8s.io`). An in-place
//     upgrade therefore crashloops the controller with "no matches for kind
//     ListenerSet" until the chart's CRD bundle is server-side applied. Doctor
//     surfaces the CRD's presence as an informational line for >= 1.8 controllers.
//
// Version detection reads the controller Deployment's image tag (the evidence the
// verification run recorded: `docker.io/envoyproxy/gateway:v1.8.3`). When no
// controller image can be found — RBAC, nonstandard install, no Envoy Gateway at
// all — the checks stay silent rather than guessing.

import type { CompositionPlanCheck } from "./composition-plan.js";
import { EXEC_TIMEOUTS, execCapture } from "./exec.js";
import { sanitizeForTerminal } from "./terminal.js";

export interface EnvoyGatewayVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Live-verified controller range: v1.5.4 (floor) through the 1.8.x line. */
export const ENVOY_GATEWAY_VERIFIED_RANGE = ">=1.5.4 <1.9";

const LISTENERSET_CRD = "listenersets.gateway.networking.k8s.io";

/**
 * Extract the controller version from an `envoyproxy/gateway` image reference.
 * Anchored to the exact repository path so the DATA-PLANE image
 * (`envoyproxy/envoy:distroless-v1.38.3`) can never be mistaken for the
 * controller; the tag must be a plain (optionally v-prefixed, optionally
 * digest-pinned) semver — anything else (`latest`, rc tags, sha-only) is
 * "not detectable" rather than a guess.
 */
export function parseEnvoyGatewayImageVersion(image: string): EnvoyGatewayVersion | null {
  const match = /(?:^|\/)envoyproxy\/gateway:v?(\d+)\.(\d+)\.(\d+)(?:@sha256:[a-f0-9]{64})?$/.exec(
    image.trim(),
  );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compare(a: EnvoyGatewayVersion, b: EnvoyGatewayVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** True when the detected controller is inside the live-verified range >=1.5.4 <1.9. */
export function isWithinVerifiedRange(version: EnvoyGatewayVersion): boolean {
  return (
    compare(version, { major: 1, minor: 5, patch: 4 }) >= 0 &&
    compare(version, { major: 1, minor: 9, patch: 0 }) < 0
  );
}

/** Minimal structural slice of a composition plan these checks need. */
export interface EnvoyGatewayPlanSlice {
  requirements: {
    kubernetes: {
      resources: Array<{ apiVersion: string }>;
    };
  };
}

/**
 * The composition plan only requires `gateway.envoyproxy.io/*` APIs when the
 * target routes through Envoy Gateway (envoyNativeRouting's EnvoyExtensionPolicy /
 * ClientTrafficPolicy). Every other target skips these checks entirely.
 */
export function planRequiresEnvoyGateway(plan: EnvoyGatewayPlanSlice): boolean {
  return plan.requirements.kubernetes.resources.some((resource) =>
    resource.apiVersion.startsWith("gateway.envoyproxy.io/"),
  );
}

async function kubectlCapture(args: string[]): Promise<string | null> {
  const result = await execCapture("kubectl", args, { timeoutMs: EXEC_TIMEOUTS.kubectl }).catch(
    () => null,
  );
  if (!result || result.exitCode !== 0) return null;
  return result.stdout;
}

export interface DetectedEnvoyGateway {
  version: EnvoyGatewayVersion;
  image: string;
}

/**
 * Find the Envoy Gateway controller image. Primary: the chart's stable
 * `control-plane=envoy-gateway` Deployment label, cluster-wide. Fallback: the
 * default install location (`envoy-gateway` Deployment in `envoy-gateway-system`)
 * for clusters where listing across namespaces is not permitted. Null (no warn)
 * when neither yields a parseable controller image.
 */
export async function detectEnvoyGatewayVersion(): Promise<DetectedEnvoyGateway | null> {
  const candidates: string[] = [];
  const labelled = await kubectlCapture([
    "get",
    "deployments",
    "-A",
    "-l",
    "control-plane=envoy-gateway",
    "-o",
    'jsonpath={range .items[*]}{range .spec.template.spec.containers[*]}{.image}{"\\n"}{end}{end}',
  ]);
  if (labelled) candidates.push(...labelled.split("\n"));
  if (!candidates.some((image) => parseEnvoyGatewayImageVersion(image))) {
    const fallback = await kubectlCapture([
      "get",
      "deployment",
      "envoy-gateway",
      "-n",
      "envoy-gateway-system",
      "-o",
      'jsonpath={range .spec.template.spec.containers[*]}{.image}{"\\n"}{end}',
      "--ignore-not-found",
    ]);
    if (fallback) candidates.push(...fallback.split("\n"));
  }
  for (const candidate of candidates) {
    const image = candidate.trim();
    if (!image) continue;
    const version = parseEnvoyGatewayImageVersion(image);
    if (version) return { version, image };
  }
  return null;
}

async function listenerSetCrdExists(): Promise<boolean | null> {
  const result = await kubectlCapture([
    "get",
    "crd",
    LISTENERSET_CRD,
    "--ignore-not-found",
    "-o",
    "name",
  ]);
  if (result === null) return null; // could not determine — stay silent
  return result.trim().length > 0;
}

/**
 * Soft Envoy Gateway compatibility checks for deploy preflight and doctor.
 * Returns [] when the target does not use Envoy Gateway or the controller
 * version is not detectable; otherwise pass/warn checks only — this can never
 * fail a deploy.
 */
export async function evaluateEnvoyGatewayPreflight(
  plan: EnvoyGatewayPlanSlice,
): Promise<CompositionPlanCheck[]> {
  if (!planRequiresEnvoyGateway(plan)) return [];
  const detected = await detectEnvoyGatewayVersion();
  if (!detected) return [];
  const checks: CompositionPlanCheck[] = [];
  const { version } = detected;
  const versionLabel = `v${version.major}.${version.minor}.${version.patch}`;
  const image = sanitizeForTerminal(detected.image);
  if (isWithinVerifiedRange(version)) {
    checks.push({
      name: "Envoy Gateway version",
      status: "pass",
      message: `${versionLabel} (${image}) is within the live-verified range ${ENVOY_GATEWAY_VERIFIED_RANGE}`,
    });
  } else {
    checks.push({
      name: "Envoy Gateway version",
      status: "warn",
      message:
        `${versionLabel} (${image}) is outside the live-verified range ` +
        `${ENVOY_GATEWAY_VERIFIED_RANGE}. The adapter's full surface (ext_proc routing, ` +
        `ClientTrafficPolicy, deploy gates, rollback) is verified on v1.5.4–v1.8.3; other ` +
        `versions are unverified, not known-broken.`,
      fix: "Prefer an Envoy Gateway release in the verified range, or verify this version against a staging cluster first",
    });
  }
  // The 1.8 install-order trap: helm upgrade does not upgrade CRDs, and >= 1.8
  // unconditionally watches ListenerSet — absence crashloops the controller.
  if (compare(version, { major: 1, minor: 8, patch: 0 }) >= 0) {
    const exists = await listenerSetCrdExists();
    if (exists === true) {
      checks.push({
        name: "ListenerSet CRD",
        status: "pass",
        message: `${LISTENERSET_CRD} present (watched unconditionally by Envoy Gateway >= 1.8)`,
      });
    } else if (exists === false) {
      checks.push({
        name: "ListenerSet CRD",
        status: "warn",
        message:
          `${LISTENERSET_CRD} is absent, but Envoy Gateway ${versionLabel} watches ListenerSet ` +
          `unconditionally — the controller crashloops after an in-place helm upgrade from ` +
          `1.5.x because helm never upgrades the chart's crds/ subchart`,
        fix:
          `helm pull oci://docker.io/envoyproxy/gateway-helm --version ${versionLabel} --untar && ` +
          `kubectl apply --server-side --force-conflicts -f gateway-helm/charts/crds/crds/ -R`,
      });
    }
  }
  return checks;
}
