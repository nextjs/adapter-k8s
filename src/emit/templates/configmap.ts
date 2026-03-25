// src/emit/templates/configmap.ts
export function renderConfigMap({
  name,
  releaseName,
  data,
}: {
  name: string;
  releaseName: string;
  data: Record<string, string>;
}): string {
  const dataEntries = Object.entries(data)
    .map(
      ([key, value]) =>
        `  ${key}: |\n${value
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n")}`,
    )
    .join("\n");
  return `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${releaseName}-${name}
data:
${dataEntries}
`;
}
