import { createHash } from "node:crypto";
import { parseCompositionPlan } from "./parse.js";
import type { CompositionPlan, CompositionPlanDigest } from "./types.js";

function canonicalize(value: unknown, path: string): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot fingerprint composition plan: ${path} is not a finite number`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry, index) => canonicalize(entry, `${path}[${index}]`)).join(",")}]`;
  }
  if (typeof value !== "object" || value === null) {
    throw new Error(
      `Cannot fingerprint composition plan: ${path} contains unsupported ${typeof value}`,
    );
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`Cannot fingerprint composition plan: ${path} is not a plain object`);
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], `${path}.${key}`)}`);
  return `{${entries.join(",")}}`;
}

/** Stable JSON used for plan fingerprints. Object-key order never affects the result. */
export function canonicalCompositionPlanJson(plan: CompositionPlan): string {
  return canonicalize(plan, "$");
}

export function fingerprintCompositionPlan(plan: CompositionPlan): CompositionPlanDigest {
  const digest = createHash("sha256").update(canonicalCompositionPlanJson(plan)).digest("hex");
  return `sha256:${digest}`;
}

/** Parse strictly before hashing so unknown fields can never hide outside the typed plan. */
export function parseAndFingerprintCompositionPlan(value: unknown): {
  plan: CompositionPlan;
  digest: CompositionPlanDigest;
} {
  const plan = parseCompositionPlan(value);
  return { plan, digest: fingerprintCompositionPlan(plan) };
}

export function parseAndVerifyCompositionPlan(
  value: unknown,
  expectedDigest: string,
): CompositionPlan {
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedDigest)) {
    throw new Error("Invalid expected composition-plan digest: expected sha256:<64 lowercase hex>");
  }
  const { plan, digest } = parseAndFingerprintCompositionPlan(value);
  if (digest !== expectedDigest) {
    throw new Error(
      `Composition-plan digest mismatch: expected ${expectedDigest}, calculated ${digest}. ` +
        `Refusing to execute an unverified operational plan.`,
    );
  }
  return plan;
}
