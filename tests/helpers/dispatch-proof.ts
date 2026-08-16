// tests/helpers/dispatch-proof.ts
//
// Trusted dispatch requests in tests are signed exactly the way the routing service and the
// cross-pool proxy sign them: a per-request HMAC proof (INTERNAL_DISPATCH_PROOF_HEADER),
// never the raw secret. One helper, so tests can never drift from the wire scheme.
import { computeDispatchProof, INTERNAL_DISPATCH_PROOF_HEADER } from "../../src/routing-common.js";

/**
 * Return `headers` plus a valid dispatch proof for (method, url). `headers` must contain
 * every covered dispatch header the request carries (x-output-id, x-mw-evaluated, …) — the
 * proof binds them, so anything added after signing invalidates it (which is the point).
 */
export function signDispatch(
  secret: string,
  method: string,
  url: string,
  headers: Record<string, string> = {},
): Record<string, string> {
  return {
    ...headers,
    [INTERNAL_DISPATCH_PROOF_HEADER]: computeDispatchProof(secret, method, url, headers),
  };
}
