export function renderRouteExtConfigMap({
  releaseName,
  extensionChainJson,
  projectId,
  region,
  forwardingRule,
}: {
  releaseName: string;
  extensionChainJson: string;
  projectId: string;
  region: string;
  forwardingRule?: string;
}): string {
  const chains = JSON.parse(extensionChainJson);

  // Build the route extension YAML for the `import` command
  const ext = chains[0]?.extensions?.[0];
  const chain = chains[0];
  const fwdRule = forwardingRule ?? 'FORWARDING_RULE_PLACEHOLDER';

  // Escape CEL expression for YAML (double quotes inside double-quoted string)
  const celExpr = chain?.matchCondition?.celExpression ?? 'true';

  const routeExtYaml = [
    `name: "${releaseName}-route-ext"`,
    `loadBalancingScheme: EXTERNAL_MANAGED`,
    `forwardingRules:`,
    `  - "${fwdRule}"`,
    `extensionChains:`,
    `  - name: "${chain?.name ?? 'nextjs-routing'}"`,
    `    matchCondition:`,
    `      celExpression: "${celExpr.replace(/"/g, '\\"')}"`,
    `    extensions:`,
    `      - name: "${ext?.name ?? 'routing-service'}"`,
    `        authority: "${ext?.authority ?? ''}"`,
    `        service: "${ext?.service ?? ''}"`,
    `        timeout: "${ext?.timeout ?? '5s'}"`,
    `        supportedEvents:`,
    `          - REQUEST_HEADERS`,
    `        failOpen: ${ext?.failOpen ?? true}`,
  ].join('\n');

  // Indent for YAML block scalar (4 spaces under `data:` key)
  const indent = '    ';
  const routeExtIndented = routeExtYaml.split('\n').map(l => indent + l).join('\n');
  const chainJsonIndented = extensionChainJson.split('\n').map(l => indent + l).join('\n');

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
