// src/providers/index.ts
import type { K8sAdapterConfig } from "../types.js";
import { gkeProvider } from "./gke.js";
import { genericProvider } from "./generic.js";
import type { ProviderAdapter } from "./types.js";

export type {
  ProviderAdapter,
  ProviderChartContext,
  ProviderName,
  ExtProcStrategy,
} from "./types.js";
export { gkeProvider } from "./gke.js";
export { genericProvider } from "./generic.js";

/**
 * Pick the legacy chart adapter for a deprecated provider config.
 *
 * `provider` is a one-key discriminated object (`{ gke: … }`), so resolution is a key check
 * rather than a name field — that shape predates this seam and keeps existing configs valid.
 * Do not register new platforms here. New integrations use target components and compile to a
 * composition plan.
 *
 * Throws on an unknown provider rather than defaulting to GKE: silently emitting a Google
 * gateway for `provider: { eks: … }` would produce a chart that installs and then does nothing
 * useful, which is far worse to debug than a config error at build time.
 */
const REGISTRY: Record<string, ProviderAdapter> = { gke: gkeProvider, generic: genericProvider };

export function resolveProvider(config: K8sAdapterConfig): ProviderAdapter {
  const configured = Object.entries(config.provider ?? {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k]) => k);

  if (configured.length === 0) {
    throw new Error(
      `No provider configured. Supported: ${Object.keys(REGISTRY)
        .map((k) => `"${k}"`)
        .join(", ")}. ` + `Set \`provider: { gke: … }\` in your adapter config.`,
    );
  }
  // The one-key invariant is enforced here rather than assumed. Selecting by "first key I
  // recognize" would let a config carrying two provider blocks — mid-migration, or a
  // copy-paste — deploy whichever stack the implementation happened to test first, with no
  // diagnostic. Two providers is always a mistake, so say so.
  if (configured.length > 1) {
    throw new Error(
      `Configure exactly one provider — found ${configured.length}: ` +
        `${configured.map((k) => `"${k}"`).join(", ")}. A config with more than one provider is ` +
        `ambiguous: the chart can only target one cluster.`,
    );
  }

  const name = configured[0]!;
  const provider = REGISTRY[name];
  if (!provider) {
    throw new Error(
      `Unsupported provider "${name}". Supported: ` +
        `${Object.keys(REGISTRY)
          .map((k) => `"${k}"`)
          .join(", ")}.`,
    );
  }
  return provider;
}
