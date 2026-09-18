import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { generateHelmChart } from "../../src/emit/helm.js";
import {
  compileTarget,
  defineTarget,
  envoyGatewayIngressSources,
  envoyNativeRouting,
  gatewayApiExposure,
  kubernetesCluster,
} from "../../src/target/index.js";
import type { PoolDefinition, RoutingManifest } from "../../src/types.js";
import { NATIVE_POOL_ROUTING_ANNOTATION } from "../../src/emit/native-pool-routing.js";
import { execCapture } from "../../src/cli/exec.js";
import {
  switchTrafficToNewBuild,
  snapshotRevertSelectors,
  flipSelectorsToPreviousBuild,
} from "../../src/cutover/traffic.js";
import { CutoverExitError } from "../../src/cutover/inputs.js";

vi.mock("../../src/cli/exec.js");

interface Rule {
  matches: { headers?: { name: string; value: string }[] }[];
  backendRefs: { name: string; port: number }[];
  timeouts?: { request: string };
}
interface Route {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace: string; annotations: Record<string, string> };
  spec: { rules: Rule[] };
}

const helm = process.env.ADAPTER_K8S_SCHEMA_HELM;
function createTarget(requestTimeout?: string) {
  return defineTarget({
    cluster: kubernetesCluster(),
    exposure: gatewayApiExposure({
      className: "envoy",
      hosts: [{ hostname: "example.invalid", tls: { enabled: false } }],
      ...(requestTimeout !== undefined ? { requestTimeout } : {}),
      ingressSources: envoyGatewayIngressSources({
        namespace: "envoy-gateway-system",
        gatewayClasses: ["envoy"],
      }),
    }),
    routing: envoyNativeRouting({ gatewayClassName: "envoy" }),
  });
}

function render(mode: "none" | "job", direct: boolean | undefined = undefined, timeout?: string) {
  const target = createTarget(timeout);
  const poolNames = ["web", "api"];
  const compiled = compileTarget(target, {
    releaseName: "site",
    namespace: "apps",
    buildId: "new",
    imageRegistry: "registry.invalid/app",
    pools: poolNames,
    defaultPool: "web",
    failurePolicy: "closed",
  });
  const pools = new Map(
    poolNames.map((name) => [name, { name, outputs: [], config: {} } as PoolDefinition]),
  );
  const files = generateHelmChart({
    pools,
    buildId: "new",
    nextVersion: "16.3.4",
    config: { target },
    imageRegistry: "registry.invalid/app",
    routingManifest: {
      buildId: "new",
      nextVersion: "16.3.4",
      routeGraph: { rsc: {} },
      pathnames: ["/api/report"],
      poolAssignments: { "/api/report": "api" },
      pprRoutes: {},
      middleware: { filePath: "middleware.js" },
    } as unknown as RoutingManifest,
    releaseName: "site",
    internalSecret: "s".repeat(64),
    compiledTarget: compiled,
  });
  const root = mkdtempSync(path.join(tmpdir(), "native-pool-routing-"));
  try {
    for (const [relative, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      writeFileSync(path.join(root, relative), body);
    }
    const rendered = execFileSync(
      helm!,
      [
        "template",
        "site",
        root,
        "--set",
        "global.networkPolicy.strict=false",
        "--set",
        "activeBuildId=old",
        "--set",
        "activeDefaultPool=web",
        "--set",
        "previousBuildId=old",
        "--set",
        "previousDefaultPool=web",
        "--set",
        `cutover.mode=${mode}`,
        ...(direct === undefined ? [] : ["--set", `nativePoolRouting=${direct}`]),
      ],
      { encoding: "utf8" },
    );
    const documents = rendered.split(/^---\s*$/m);
    const route = documents
      .filter((document) => document.includes('"kind": "HTTPRoute"'))
      .map((document) => JSON.parse(document.slice(document.indexOf("{"))))
      .find((document) => document.kind === "HTTPRoute") as Route;
    const services = new Map<string, { component: string; version: string }>();
    for (const document of documents.filter((document) => /^kind: Service$/m.test(document))) {
      const name = /^  name: (.+)$/m.exec(document)![1]!;
      if (!["site-web", "site-api", "site-origin"].includes(name)) continue;
      const selector = document.split("  selector:\n")[1]!.split("  ports:")[0]!;
      services.set(name, {
        component: /app.kubernetes.io\/component: "(.+)"/.exec(selector)![1]!,
        version: /app.kubernetes.io\/version: "(.+)"/.exec(selector)![1]!,
      });
    }
    return { route, services, plan: compiled.plan };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// The schema lane supplies its pinned Helm binary. This exercises the real chart rather
// than approximating Go-template conditionals in the unit runner.
describe.skipIf(!helm)("native pool routing before promotion", () => {
  it.each(["none", "job"] as const)(
    "%s keeps a route moved into a new pool on the existing origin before promotion",
    (mode) => {
      const { route, services } = render(mode);
      const selected = route.spec.rules.find((rule) =>
        rule.matches.some(
          (match) => !match.headers || match.headers.some((header) => header.value === "api"),
        ),
      )!.backendRefs[0]!.name;
      const readyPods = [
        { component: "web", version: "old" },
        { component: "web", version: "new" },
        { component: "api", version: "new" },
      ];
      expect(readyPods).toContainEqual(services.get(selected));
      expect(selected).toBe("site-origin");
      expect(route.spec.rules).toHaveLength(1);
      expect(route.metadata.annotations[NATIVE_POOL_ROUTING_ANNOTATION]).toBe("origin");
    },
  );

  it.each(["none", "job"] as const)(
    "%s preserves an available origin through promotion, failed promotion and rollback",
    async (mode) => {
      const { route, services } = render(mode);
      const selectors = new Map(
        [...services].map(([name, selector]) => [
          name,
          {
            "app.kubernetes.io/name": "site",
            "app.kubernetes.io/component": selector.component,
            "app.kubernetes.io/version": selector.version,
          },
        ]),
      );
      let failApi = false;
      vi.mocked(execCapture).mockImplementation(async (_command, args) => {
        const service = args[2]!;
        const current = selectors.get(service)!;
        if (args[0] === "get") {
          return {
            exitCode: 0,
            stderr: "",
            stdout: args.includes("--ignore-not-found")
              ? `service/${service}`
              : JSON.stringify({ spec: { selector: current } }),
          };
        }
        expect(args.slice(0, 2)).toEqual(["patch", "service"]);
        const patch = JSON.parse(args[args.indexOf("-p") + 1]!) as {
          op: string;
          value: typeof current;
        }[];
        expect(patch[0]!.value).toEqual(current);
        if (failApi && service === "site-api")
          return { exitCode: 1, stdout: "", stderr: "injected patch failure" };
        selectors.set(service, patch[1]!.value);
        return { exitCode: 0, stdout: "", stderr: "" };
      });
      const selected = route.spec.rules[0]!.backendRefs[0]!.name;
      const responseBuild = () => {
        const entry = selectors.get(selected)!;
        const version = entry["app.kubernetes.io/version"];
        // The existing URL belongs to old/web and new/api. After E1 completes, the
        // new origin's local forward must find new/api. Failed E1 restores old/web.
        if (version === "new")
          expect(selectors.get("site-api")).toMatchObject({
            "app.kubernetes.io/component": "api",
            "app.kubernetes.io/version": "new",
          });
        else
          expect(entry).toMatchObject({
            "app.kubernetes.io/component": "web",
            "app.kubernetes.io/version": "old",
          });
        return version;
      };
      const restoreEdge = vi.fn(async () => ({ attempted: true, restored: true, error: "" }));
      const promote = () =>
        switchTrafficToNewBuild({
          releaseName: "site",
          namespace: "apps",
          safeBuildId: "new",
          expectedCurrentBuildId: "old",
          pools: ["web", "api"],
          hasPortableOrigin: true,
          defaultPool: "web",
          deps: { restoreEdgeToPreviousBuild: restoreEdge, edgeStatusLines: () => [] },
          restoreWarmedHpas: async () => {},
        });
      expect(responseBuild()).toBe("old");
      failApi = true;
      await expect(promote()).rejects.toBeInstanceOf(CutoverExitError);
      expect(restoreEdge).toHaveBeenCalledOnce();
      expect(responseBuild()).toBe("old");
      failApi = false;
      await promote();
      expect(responseBuild()).toBe("new");
      const state = {
        buildId: "new",
        previousBuildId: "old",
        defaultPools: { old: "web", new: "web" },
      };
      const revert = await snapshotRevertSelectors({
        releaseName: "site",
        namespace: "apps",
        poolNames: ["web"],
        currentPoolNames: ["web", "api"],
        previousBuildId: "old",
        state,
      });
      await flipSelectorsToPreviousBuild({
        releaseName: "site",
        namespace: "apps",
        currentBuildId: "new",
        previousBuildId: "old",
        safePreviousBuild: "old",
        plan: revert,
        state,
        registry: undefined,
      });
      expect(responseBuild()).toBe("old");
      expect(selectors.get("site-api")).toMatchObject({
        "app.kubernetes.io/component": "web",
        "app.kubernetes.io/version": "old",
      });
      await promote();
      expect(responseBuild()).toBe("new");
    },
  );

  it("job mode ignores an inherited direct-routing value", () => {
    const { route } = render("job", true);
    expect(route.spec.rules.map((rule) => rule.backendRefs[0]!.name)).toEqual(["site-origin"]);
  });

  it.each([false, true])(
    "renders a complete routing variant for direct=%s without changing readiness identities",
    (direct) => {
      const { route, plan } = render("none", direct);
      expect(route.spec.rules.map((rule) => rule.backendRefs[0]!.name)).toEqual(
        direct ? ["site-api", "site-origin"] : ["site-origin"],
      );
      expect(route.metadata.annotations[NATIVE_POOL_ROUTING_ANNOTATION]).toBe(
        direct ? "owning" : "origin",
      );
      expect(plan.operations.resources.readiness).toContainEqual(
        expect.objectContaining({
          object: expect.objectContaining({
            name: route.metadata.name,
            namespace: route.metadata.namespace,
          }),
        }),
      );
      expect(route.spec.rules.every((rule) => rule.timeouts === undefined)).toBe(true);
    },
  );

  it.each([
    { direct: false, timeout: "0s" },
    { direct: true, timeout: "0s" },
    { direct: false, timeout: "30s" },
    { direct: true, timeout: "30s" },
  ])("preserves explicit requestTimeout=$timeout for direct=$direct", ({ direct, timeout }) => {
    const { route } = render("none", direct, timeout);
    expect(route.spec.rules.every((rule) => rule.timeouts?.request === timeout)).toBe(true);
  });
});
