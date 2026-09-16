import { describe, expect, it } from "vitest";
import {
  classifyPprRequest,
  decidePprInvocation,
  type PprInvocationDecisionInput,
} from "../../src/pool-server/dispatch.js";

describe("classifyPprRequest", () => {
  const classify = (over: Partial<Parameters<typeof classifyPprRequest>[0]> = {}) =>
    classifyPprRequest({
      method: "GET",
      rsc: undefined,
      routerPrefetch: undefined,
      segmentPrefetch: undefined,
      nextAction: undefined,
      resumeStateLength: undefined,
      resume: undefined,
      ...over,
    });

  it("classifies a segment header before document negotiation", () => {
    expect(classify({ segmentPrefetch: "/__PAGE__" })).toBe("segment-prefetch");
  });

  it("separates dynamic RSC, full-page prefetch, and document requests", () => {
    expect(classify({ rsc: "1" })).toBe("dynamic-rsc");
    expect(classify({ rsc: "1", routerPrefetch: "1" })).toBe("other");
    expect(classify()).toBe("capturable-document");
    expect(classify({ resume: "1" })).toBe("noncapturable-document");
  });
});

const base: PprInvocationDecisionInput = {
  routeKind: "none",
  requestKind: "capturable-document",
  sharedCache: false,
  entrypointOwnsPprShell: false,
  partialPrefetching: false,
  platformFullyKeyed: false,
  shellInjected: false,
  staleStoredEntry: false,
};

describe("decidePprInvocation", () => {
  const cases: Array<{
    name: string;
    input: Partial<PprInvocationDecisionInput>;
    forceNonMinimal: boolean;
    capturePostponedState: boolean;
  }> = [
    {
      name: "leaves non-PPR documents minimal",
      input: {},
      forceNonMinimal: false,
      capturePostponedState: false,
    },
    {
      name: "uses an injected build shell in minimal mode",
      input: { routeKind: "build-shell", sharedCache: true, shellInjected: true },
      forceNonMinimal: false,
      capturePostponedState: false,
    },
    {
      name: "captures when a shared-cache build shell cannot be injected",
      input: { routeKind: "build-shell", sharedCache: true },
      forceNonMinimal: false,
      capturePostponedState: true,
    },
    {
      name: "lets Next regenerate a stale stored build-shell entry",
      input: { routeKind: "build-shell", sharedCache: true, staleStoredEntry: true },
      forceNonMinimal: true,
      capturePostponedState: false,
    },
    {
      name: "lets Next handle a non-document build-shell request",
      input: { routeKind: "build-shell", requestKind: "other", sharedCache: true },
      forceNonMinimal: true,
      capturePostponedState: false,
    },
    {
      name: "lets Next select a root-param shell with shared cache",
      input: { routeKind: "root-params", sharedCache: true },
      forceNonMinimal: true,
      capturePostponedState: false,
    },
    {
      name: "does not invent a root-param owner without a cache",
      input: { routeKind: "root-params" },
      forceNonMinimal: false,
      capturePostponedState: false,
    },
    {
      name: "captures a shell-less runtime PPR document",
      input: { routeKind: "runtime-capture" },
      forceNonMinimal: false,
      capturePostponedState: true,
    },
    {
      name: "lets Next own actions or existing resumes on shell-less runtime PPR",
      input: { routeKind: "runtime-capture", requestKind: "noncapturable-document" },
      forceNonMinimal: true,
      capturePostponedState: false,
    },
    {
      name: "lets Next own dynamic RSC on shell-less runtime PPR",
      input: { routeKind: "runtime-capture", requestKind: "dynamic-rsc" },
      forceNonMinimal: true,
      capturePostponedState: false,
    },
    {
      name: "persists a fully keyed partial-prefetch entry through shared cache",
      input: {
        routeKind: "runtime-capture",
        sharedCache: true,
        partialPrefetching: true,
        platformFullyKeyed: true,
      },
      forceNonMinimal: true,
      capturePostponedState: false,
    },
    {
      name: "lets Next own partial-prefetch build shells without shared cache",
      input: { routeKind: "build-shell", partialPrefetching: true },
      forceNonMinimal: true,
      capturePostponedState: false,
    },
    {
      name: "lets the filesystem-cache harness own a build shell",
      input: { routeKind: "build-shell", entrypointOwnsPprShell: true },
      forceNonMinimal: true,
      capturePostponedState: false,
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(decidePprInvocation({ ...base, ...testCase.input })).toEqual({
        forceNonMinimal: testCase.forceNonMinimal,
        capturePostponedState: testCase.capturePostponedState,
      });
    });
  }
});
