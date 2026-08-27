// tests/helpers/dispatch-proof.ts
//
// Trusted dispatch requests in tests are signed exactly the way the routing service and the
// cross-pool proxy sign them: a per-request HMAC proof (INTERNAL_DISPATCH_PROOF_HEADER),
// never the raw secret. One helper, so tests can never drift from the wire scheme.
import {
  computeDispatchProof,
  dispatchProofInputsFromRequest,
  INTERNAL_DISPATCH_PROOF_HEADER,
} from "../../src/routing-common.js";

/** Everything the proof binds beyond the headers a test hands to its HTTP client. */
export interface SignDispatchContext {
  /**
   * A0-DP-5. The request body, when the test wants it BOUND (as the cross-pool hop binds it).
   * Omit for the ext_proc-shaped case, which binds the ABSENT symbol.
   */
  body?: Buffer | undefined;
  /** Mint time. Defaults to now; pass an old value to exercise the freshness window. */
  issuedAtMs?: number | undefined;
  /**
   * The `Host` the request will carry — for a `fetch` against a test server that is
   * `` `127.0.0.1:${port}` `` or `` `localhost:${port}` ``, i.e. whatever the client puts on the
   * wire, since the proof covers the authority. Omit only when the request genuinely has no Host
   * (a synthetic req/res pair), which the proof covers as ABSENT on both sides.
   */
  authority?: string | undefined;
  /** This build's proof-covered request headers (routing-common.ts buildProofHeaderNames). */
  proofHeaderNames?: readonly string[] | undefined;
}

/**
 * Return `headers` plus a valid dispatch proof for this request. `headers` must contain every
 * covered value the request carries — the dispatch vocabulary (x-output-id, x-mw-evaluated, …),
 * the forwarding witnesses (`x-forwarded-proto`/`x-forwarded-host`) and any matcher-input header —
 * and `context.authority` must be the Host the client will send. The proof binds all of it, so
 * anything added or changed after signing invalidates it (which is the point).
 */
export function signDispatch(
  secret: string,
  method: string,
  url: string,
  headers: Record<string, string> = {},
  context: SignDispatchContext = {},
): Record<string, string> {
  const wire: Record<string, string> = { ...headers };
  if (context.authority !== undefined) wire["host"] = context.authority;
  return {
    ...headers,
    [INTERNAL_DISPATCH_PROOF_HEADER]: computeDispatchProof(
      secret,
      dispatchProofInputsFromRequest(
        {
          method,
          target: url,
          headers: wire,
          proofHeaderNames: context.proofHeaderNames,
        },
        { body: context.body, issuedAtMs: context.issuedAtMs },
      ),
    ),
  };
}
