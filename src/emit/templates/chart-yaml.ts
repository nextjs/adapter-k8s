// src/emit/templates/chart-yaml.ts
import { assertSafeReleaseName } from "./utils.js";

// Chart.yaml `version`/`appVersion` must be SemVer or helm refuses to load the chart, and
// `name` is the release name. Both are spliced into bare/quoted YAML scalars.
//
// This is a CHARSET/shape guard at the consumption point, not a full SemVer implementation:
// it deliberately does not reject a prerelease identifier with a leading zero
// (`0.1.0-2026.07.25`, which helm's own semver DOES reject). Constructing a version helm
// will accept is the caller's job — see the `safeVersionSuffix` derivation in emit/helm.ts.
const CHART_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export function renderChartYaml({ name, version }: { name: string; version: string }): string {
  // Sanitize at the point of consumption (AGENTS.md) — neither field was checked here.
  assertSafeReleaseName(name);
  if (!CHART_VERSION_RE.test(version)) {
    throw new Error(
      `Invalid chart version "${version}": must be SemVer (${CHART_VERSION_RE}). helm ` +
        `rejects a non-SemVer chart version with "chart.metadata.version … is invalid", ` +
        `which fails the deploy AFTER the build and image push.`,
    );
  }
  return `apiVersion: v2
name: ${name}
description: Next.js application deployed via @next-community/adapter-k8s
version: ${version}
appVersion: "${version}"
`;
}
