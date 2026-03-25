// src/emit/templates/chart-yaml.ts
export function renderChartYaml({ name, version }: { name: string; version: string }): string {
  return `apiVersion: v2
name: ${name}
description: Next.js application deployed via @next-community/adapter-k8s
version: ${version}
appVersion: "${version}"
`;
}
