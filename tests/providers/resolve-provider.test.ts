// The provider seam's dispatch rule. `provider` is a one-key discriminated object, and that
// invariant is load-bearing once more than one provider exists: picking by "first key I
// recognize" silently prefers one stack over another.
import { describe, it, expect } from "vitest";
import { resolveProvider } from "../../src/providers/index.js";
import type { K8sAdapterConfig } from "../../src/types.js";

const base = { pools: {} } as unknown as K8sAdapterConfig;
const cfg = (provider: unknown) => ({ ...base, provider }) as K8sAdapterConfig;

describe("resolveProvider", () => {
  it("resolves gke", () => {
    expect(resolveProvider(cfg({ gke: { gateway: { hosts: [] } } })).name).toBe("gke");
  });

  it("carries the ext_proc strategy for the resolved provider", () => {
    expect(resolveProvider(cfg({ gke: {} })).extProcStrategy).toBe("gke-traffic-extension");
  });

  it("rejects a config with NO provider rather than defaulting", () => {
    // Defaulting to GKE would emit a Google gateway that installs cleanly and then does
    // nothing useful — far worse to debug than a config error.
    expect(() => resolveProvider(cfg({}))).toThrow(/no provider configured/i);
  });

  it("rejects an unknown provider by name", () => {
    expect(() => resolveProvider(cfg({ eks: {} }))).toThrow(/eks/);
  });

  it("rejects MORE THAN ONE provider instead of silently preferring one", () => {
    // Found by review: a config carrying both an old and a new provider block (mid-migration,
    // or a copy-paste) would resolve to whichever key the implementation happened to test
    // first, deploying the wrong stack with no diagnostic. The shape is one-key by contract,
    // so enforce it at the dispatch point.
    expect(() => resolveProvider(cfg({ gke: {}, eks: {} }))).toThrow(/exactly one/i);
  });

  it("names every configured provider in the multi-provider error", () => {
    const err = (() => {
      try {
        resolveProvider(cfg({ gke: {}, aks: {} }));
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(err).toContain("gke");
    expect(err).toContain("aks");
  });
});
