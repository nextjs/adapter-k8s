// The edge sandbox is a separate JS realm with its own `globalThis`, so Next's `use cache`
// handler registry — which the node side populates via Symbol.for slots — is EMPTY there.
// Measured live (k3d Phase 2, next-after-app-deploy): an edge-runtime after() calling
// revalidatePath logged "revalidating" and wrote NOTHING — revalidateTags found no handlers
// in the sandbox realm and workStore.incrementalCache had nothing Valkey-backed to fall back
// to (edge-middleware apps register no classic cacheHandler). Symbol.for is isolate-wide, so
// mirroring the node-side registry slots onto the sandbox's globalThis makes the edge realm's
// getCacheHandlers() return the SAME node-side Valkey handlers.
import { afterEach, describe, expect, it } from "vitest";
import { seedSandboxCacheHandlerRegistry } from "../../../src/pool-server/valkey-cache/register.js";

const SEED = Symbol.for("@next/cache-handlers");
const MAP = Symbol.for("@next/cache-handlers-map");
const SET = Symbol.for("@next/cache-handlers-set");
const ALL = [SEED, MAP, SET];

const globalRef = globalThis as Record<symbol, unknown>;
const saved = ALL.map((sym) => [sym, globalRef[sym]] as const);

afterEach(() => {
  for (const [sym, value] of saved) {
    if (value === undefined) delete globalRef[sym];
    else globalRef[sym] = value;
  }
});

describe("seedSandboxCacheHandlerRegistry", () => {
  it("mirrors every populated registry slot onto the sandbox globalThis by identity", () => {
    const handler = { updateTags: () => Promise.resolve() };
    const seed = { DefaultCache: handler, RemoteCache: handler };
    const map = new Map([["default", handler]]);
    const set = new Set([handler]);
    globalRef[SEED] = seed;
    globalRef[MAP] = map;
    globalRef[SET] = set;

    const sandboxGlobal: Record<symbol, unknown> = {};
    seedSandboxCacheHandlerRegistry(sandboxGlobal);

    expect(sandboxGlobal[SEED]).toBe(seed);
    expect(sandboxGlobal[MAP]).toBe(map);
    expect(sandboxGlobal[SET]).toBe(set);
  });

  it("leaves slots the node side never populated absent in the sandbox", () => {
    const seed = { DefaultCache: {} };
    globalRef[SEED] = seed;
    delete globalRef[MAP];
    delete globalRef[SET];

    const sandboxGlobal: Record<symbol, unknown> = {};
    seedSandboxCacheHandlerRegistry(sandboxGlobal);

    expect(sandboxGlobal[SEED]).toBe(seed);
    expect(MAP in sandboxGlobal).toBe(false);
    expect(SET in sandboxGlobal).toBe(false);
  });
});
