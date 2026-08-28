import type { ValkeyClient } from "./client.js";

/** Read Valkey's wall clock as one integer millisecond value. */
export const READ_VALKEY_TIME_SCRIPT = `
local t = redis.call('TIME')
return t[1] * 1000 + math.floor(t[2] / 1000)
`;

export interface ValkeyClockSample {
  /** Valkey epoch milliseconds at the sample. */
  serverNow: number;
  /** Midpoint of the local request around the Valkey round trip. */
  localNow: number;
  toLocal(serverTimestamp: number): number;
}

/**
 * Sample the shared cache clock for one operation.
 *
 * Sampling per operation is deliberate. A cached offset becomes wrong after a Valkey endpoint
 * failover or a node clock correction, exactly when freshness decisions matter most. The midpoint
 * bounds ordinary network latency without introducing offset state that needs invalidation.
 */
export async function sampleValkeyClock(
  client: ValkeyClient,
  now: () => number,
): Promise<ValkeyClockSample> {
  const before = now();
  const reply = await client.eval(READ_VALKEY_TIME_SCRIPT, 0);
  const after = now();
  if (
    !Number.isFinite(before) ||
    !Number.isFinite(after) ||
    typeof reply !== "number" ||
    !Number.isFinite(reply)
  ) {
    throw new Error("Valkey TIME returned an invalid timestamp");
  }
  const serverNow = Number(reply);
  const localNow = (before + after) / 2;
  const offset = serverNow - localNow;
  return {
    serverNow,
    localNow,
    toLocal: (timestamp) => timestamp - offset,
  };
}
