import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildHeaderMutationResponse } from "../../src/routing-service/response-builders.js";
import { createRoutingServer } from "../../src/routing-service/server.js";
import type { HeaderValue } from "../../src/routing-service/ext-proc-types.js";

// Real Envoy regression for the route-cache contract. A protobuf round-trip alone cannot prove
// that Envoy applies a mutated routing header before choosing the upstream cluster. The two
// control requests below carry the same mutations with only clearRouteCache disabled; they prove
// that the initial route otherwise remains latched for both setting and removing the pool header.

function docker(args: string[]): string {
  return (
    execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) || ""
  ).trim();
}

let dockerAvailable = false;
try {
  docker(["ps"]);
  dockerAvailable = true;
} catch {
  dockerAvailable = false;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function headerValue(headers: HeaderValue[], name: string): string | undefined {
  const header = headers.find((entry) => entry.key.toLowerCase() === name.toLowerCase());
  if (header?.value !== undefined) return header.value;
  if (header?.rawValue !== undefined) return header.rawValue.toString("utf8");
  return undefined;
}

function listenBackend(name: string): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        backend: name,
        poolHeader: req.headers["x-upstream-pool"] ?? null,
      }),
    );
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error(`Could not determine ${name} backend port`));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

describe.skipIf(!dockerAvailable)("ext_proc route-cache clearing (real Envoy)", () => {
  const containerName = `adapter-k8s-route-cache-${process.pid}`;
  const previousTransport = process.env.ROUTING_TRANSPORT;
  let red: Awaited<ReturnType<typeof listenBackend>> | undefined;
  let blue: Awaited<ReturnType<typeof listenBackend>> | undefined;
  let routingServer: ReturnType<typeof createRoutingServer> | undefined;
  let envoyPort = 0;

  beforeAll(async () => {
    red = await listenBackend("red");
    blue = await listenBackend("blue");

    process.env.ROUTING_TRANSPORT = "h2c";
    routingServer = createRoutingServer({
      port: 0,
      failOpen: false,
      timeoutMs: 1_000,
      handler: async (headers) => {
        const pathname = headerValue(headers, ":path") ?? "/";
        const removesPool = pathname.startsWith("/remove/");
        const response = removesPool
          ? buildHeaderMutationResponse([], ["x-upstream-pool"])
          : buildHeaderMutationResponse([{ key: "x-upstream-pool", value: "blue" }]);

        // Differential control: same protobuf/header mutation, only the cache-clear bit differs.
        // Without this request the test could pass merely because the mutation was accepted,
        // without proving that the bit itself changed backend selection.
        if (pathname.endsWith("/retain")) {
          response.requestHeaders!.response!.clearRouteCache = false;
        }
        return response;
      },
    });
    const { port: routingPort } = await routingServer.start();

    const envoyConfig = `static_resources:
  listeners:
    - name: listener
      address:
        socket_address: { address: 0.0.0.0, port_value: 18080 }
      filter_chains:
        - filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: route_cache_test
                route_config:
                  name: routes
                  virtual_hosts:
                    - name: app
                      domains: ["*"]
                      routes:
                        - match:
                            prefix: "/"
                            headers:
                              - name: x-upstream-pool
                                string_match: { exact: blue }
                          route: { cluster: blue }
                        - match: { prefix: "/" }
                          route: { cluster: red }
                http_filters:
                  - name: envoy.filters.http.ext_proc
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.ext_proc.v3.ExternalProcessor
                      grpc_service:
                        envoy_grpc: { cluster_name: routing-service }
                        timeout: 2s
                      failure_mode_allow: false
                      message_timeout: 2s
                      processing_mode:
                        request_header_mode: SEND
                        response_header_mode: SKIP
                        request_body_mode: NONE
                        response_body_mode: NONE
                        request_trailer_mode: SKIP
                        response_trailer_mode: SKIP
                      mutation_rules: { allow_all_routing: true }
                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
  clusters:
    - name: routing-service
      connect_timeout: 1s
      type: STRICT_DNS
      typed_extension_protocol_options:
        envoy.extensions.upstreams.http.v3.HttpProtocolOptions:
          "@type": type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions
          explicit_http_config: { http2_protocol_options: {} }
      load_assignment:
        cluster_name: routing-service
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address: { address: host.docker.internal, port_value: ${routingPort} }
    - name: red
      connect_timeout: 1s
      type: STRICT_DNS
      load_assignment:
        cluster_name: red
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address: { address: host.docker.internal, port_value: ${red.port} }
    - name: blue
      connect_timeout: 1s
      type: STRICT_DNS
      load_assignment:
        cluster_name: blue
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address: { address: host.docker.internal, port_value: ${blue.port} }
`;

    docker([
      "run",
      "-d",
      "--rm",
      "--name",
      containerName,
      "--add-host",
      "host.docker.internal:host-gateway",
      "-p",
      "127.0.0.1::18080",
      "envoyproxy/envoy:v1.32-latest",
      "--config-yaml",
      envoyConfig,
      "--log-level",
      "warning",
    ]);
    envoyPort = Number(docker(["port", containerName, "18080/tcp"]).split(":").pop());

    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${envoyPort}/ready`, {
          signal: AbortSignal.timeout(500),
        });
        await response.arrayBuffer();
        return;
      } catch {
        await sleep(100);
      }
    }
    throw new Error(`Envoy did not become ready:\n${docker(["logs", containerName])}`);
  }, 120_000);

  afterAll(async () => {
    try {
      docker(["rm", "-f", containerName]);
    } catch {
      // The container may already have exited after a configuration failure.
    }
    await routingServer?.stop().catch(() => undefined);
    await Promise.all([closeServer(red?.server), closeServer(blue?.server)]);
    if (previousTransport === undefined) delete process.env.ROUTING_TRANSPORT;
    else process.env.ROUTING_TRANSPORT = previousTransport;
  });

  async function request(pathname: string, poolHeader?: string) {
    const response = await fetch(`http://127.0.0.1:${envoyPort}${pathname}`, {
      headers: poolHeader ? { "x-upstream-pool": poolHeader } : undefined,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as { backend: string; poolHeader: string | null };
  }

  it("reselects the backend after setting x-upstream-pool", async () => {
    // Both requests reach the backend with the mutation. Only clearRouteCache changes which
    // backend Envoy chooses, proving that merely serializing the header is insufficient.
    await expect(request("/set/retain")).resolves.toEqual({
      backend: "red",
      poolHeader: "blue",
    });
    await expect(request("/set/clear")).resolves.toEqual({
      backend: "blue",
      poolHeader: "blue",
    });
  });

  it("reselects safely after stripping a spoofed x-upstream-pool", async () => {
    // The initial route is attacker-selected blue. Header removal reaches both backends, but
    // only route-cache clearing returns selection to the clean catch-all red route.
    await expect(request("/remove/retain", "blue")).resolves.toEqual({
      backend: "blue",
      poolHeader: null,
    });
    await expect(request("/remove/clear", "blue")).resolves.toEqual({
      backend: "red",
      poolHeader: null,
    });
  });
});
