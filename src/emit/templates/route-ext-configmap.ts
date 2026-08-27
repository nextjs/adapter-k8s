import { createHash } from "node:crypto";
import {
  assertSafeCelScalar,
  assertSafeGcpResourceName,
  assertSafeReleaseName,
  assertSafeYamlScalar,
} from "./utils.js";

/**
 * S9. The document body produced by the most recent renderRouteExtConfigMap call. The Job and
 * the ConfigMap are rendered back-to-back from the same inputs in emit/helm.ts, so this is a
 * deliberate (single-threaded, synchronous) handoff rather than re-deriving the document in a
 * second place where the two could drift.
 */
let lastRenderedRouteExtDocument = "";

/** S9. SHA-256 of the document the last render produced — what the Job pins the mount to. */
export function routeExtDocumentDigest(): string {
  return createHash("sha256").update(lastRenderedRouteExtDocument, "utf8").digest("hex");
}

export function renderRouteExtConfigMap({
  releaseName,
  extensionName = `${releaseName}-traffic-ext`,
  extensionChainJson,
  forwardingRule,
}: {
  releaseName: string;
  extensionName?: string;
  extensionChainJson: string;
  forwardingRule?: string;
}): string {
  // Sanitize at the point of consumption (AGENTS.md). This file's output is mounted into a
  // Job that runs `gcloud service-extensions lb-traffic-extensions import` under a
  // privileged Workload Identity, so it is one of the highest-value injection sinks in the
  // chart — and it had no releaseName guard at all.
  assertSafeReleaseName(releaseName);
  assertSafeGcpResourceName(extensionName, "traffic extension name");

  const chains = JSON.parse(extensionChainJson);

  // Read the ONE chain / ONE extension this template can express. Extra entries used to be
  // silently discarded (`chains[0].extensions[0]`), which for an extension chain means
  // quietly dropping a callout an operator believes is registered.
  if (!Array.isArray(chains) || chains.length !== 1) {
    throw new Error(
      `extension-chains.json must contain exactly one chain, got ` +
        `${Array.isArray(chains) ? chains.length : typeof chains}: this template renders a ` +
        `single extensionChain and additional entries would be silently discarded.`,
    );
  }
  const chain = chains[0];
  if (!Array.isArray(chain?.extensions) || chain.extensions.length !== 1) {
    throw new Error(
      `extension-chains.json chain "${chain?.name}" must contain exactly one extension, got ` +
        `${Array.isArray(chain?.extensions) ? chain.extensions.length : typeof chain?.extensions}.`,
    );
  }
  const ext = chain.extensions[0];
  const fwdRule = forwardingRule ?? "FORWARDING_RULE_PLACEHOLDER";

  // N67 (SECURITY). failOpen must be EXPLICIT. It used to default `?? true` — the
  // middleware-BYPASS direction, in the very file that configures the fail-closed posture
  // (invariant 2: "ext_proc failure mode is closed when the app has middleware").
  // `generateExtensionChain` always sets the field, so the old default only bit a
  // hand-written, tampered, or older `extension-chains.json` — which is precisely the input
  // this function JSON.parses and hands to a privileged `gcloud … import`. Rejecting is
  // strictly better than defaulting in either direction: a missing field means we do not
  // know the operator's intent, and guessing "open" silently disables middleware at the
  // edge for every request.
  if (typeof ext.failOpen !== "boolean") {
    throw new Error(
      `extension-chains.json extension "${ext?.name}" is missing a boolean \`failOpen\`: ` +
        `refusing to default it. Fail-open bypasses middleware at the edge (invariant 2), ` +
        `and fail-closed 500s the site — the policy must be stated, not guessed. Regenerate ` +
        `the chain with generateExtensionChain (determineFailureMode picks it from the ` +
        `app's middleware presence and routingService.failureMode).`,
    );
  }

  // Escape CEL expression for YAML. This MUST be a single-quoted YAML scalar: the CEL
  // text is already CEL-escaped (escapeCelString turns ' into \'), and \' is NOT a valid
  // escape in a YAML double-quoted scalar — an apostrophe in a public path (o'brien.txt)
  // would make route-extension.yaml unparseable and the extension would never register.
  // YAML single-quote escaping doubles the quote (' -> ''), so a CEL \' becomes \'' and
  // the YAML parser reads it back as \' — an exact round-trip. (escapeCelString also
  // rejects control characters, so no newline can reach this scalar.)
  const celExpr = chain?.matchCondition?.celExpression ?? "true";
  // S29. …but this scalar had NO consumption-point check, unlike every neighbour below —
  // it relied entirely on its producer, contradicting this file's own "the JSON may have been
  // hand-edited or tampered with" posture. A crafted celExpression closes the single-quoted
  // scalar and injects a sibling key under extensionChains[0] (proven against real helm/go-yaml),
  // which a privileged `gcloud … import` then applies. Rejected, not escaped, for the same
  // reason as its neighbours: escapeCelString already percent-encodes everything outside the
  // RFC-3986 path set, so a value outside this charset did not come from the generator.
  assertSafeCelScalar(celExpr, "extension-chains.json matchCondition.celExpression");

  // N67. The values below go into DOUBLE-quoted YAML scalars and got none of the CEL
  // scalar's care: a `"` breaks out, a `\` is an invalid escape, a control character folds.
  // Reject rather than escape (same call as assertSafePathname) — every one of them is
  // generated by extension-chain.ts from already-validated inputs, so a value outside the
  // charset means the JSON was hand-edited or tampered with.
  const chainName = chain?.name ?? "nextjs-routing";
  const extName = ext?.name ?? "routing-service";
  const authority = ext?.authority ?? "";
  const service = ext?.service ?? "";
  const timeout = ext?.timeout ?? "5s";
  assertSafeYamlScalar(chainName, "extension-chains.json chain name");
  assertSafeYamlScalar(extName, "extension-chains.json extension name");
  assertSafeYamlScalar(authority, "extension-chains.json extension authority");
  assertSafeYamlScalar(service, "extension-chains.json extension service");
  assertSafeYamlScalar(timeout, "extension-chains.json extension timeout");
  assertSafeYamlScalar(fwdRule, "forwardingRule");

  const routeExtYaml = [
    `name: "${extensionName}"`,
    `loadBalancingScheme: EXTERNAL_MANAGED`,
    `forwardingRules:`,
    `  - "${fwdRule}"`,
    `extensionChains:`,
    `  - name: "${chainName}"`,
    `    matchCondition:`,
    `      celExpression: '${celExpr.replace(/'/g, "''")}'`,
    `    extensions:`,
    `      - name: "${extName}"`,
    `        authority: "${authority}"`,
    `        service: "${service}"`,
    `        timeout: "${timeout}"`,
    `        supportedEvents:`,
    `          - REQUEST_HEADERS`,
    `        failOpen: ${ext.failOpen}`,
  ].join("\n");

  // S9 (SECURITY). The EXACT bytes the mounted `/config/route-extension.yaml` will hold: a
  // block scalar with `|` reproduces its lines verbatim plus one trailing newline. Exported so
  // the update Job can be rendered with a digest of this document and refuse to import a
  // ConfigMap that does not match it (see routeExtDocumentDigest below).
  lastRenderedRouteExtDocument = routeExtYaml + "\n";

  // Indent for YAML block scalar (4 spaces under `data:` key)
  const indent = "    ";
  const routeExtIndented = routeExtYaml
    .split("\n")
    .map((l) => indent + l)
    .join("\n");
  const chainJsonIndented = extensionChainJson
    .split("\n")
    .map((l) => indent + l)
    .join("\n");

  return `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${releaseName}-route-ext-config
data:
  route-extension.yaml: |
${routeExtIndented}
  extension-chains.json: |
${chainJsonIndented}
`;
}
