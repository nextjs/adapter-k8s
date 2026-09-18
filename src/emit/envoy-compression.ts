// Pinned multi-platform Envoy 1.38.3, also used by local emulation.
export const COMPRESSION_ENVOY_IMAGE =
  "envoyproxy/envoy@sha256:5f7c43e1147412fdb3af578c651c67478a3df818eae89d2261e707e06c209cdb";

/** Preserve Accept-Encoding: middleware and the dispatch proof see the original headers. */
export function compressionFilters() {
  const contentTypes = [
    "text/html",
    "text/plain",
    "text/css",
    "text/javascript",
    "text/xml",
    "text/x-component",
    "application/javascript",
    "application/x-javascript",
    "application/json",
    "application/xml",
    "application/xhtml+xml",
    "application/wasm",
    "image/svg+xml",
  ];
  return [
    { name: "gzip", type: "Gzip", config: { compression_level: "BEST_SPEED" } },
    { name: "zstd", type: "Zstd", config: { compression_level: 3 } },
    { name: "brotli", type: "Brotli", config: { quality: 4 } },
  ].map(({ name, type, config }) => {
    const filter = {
      name: `envoy.filters.http.compressor.${name}`,
      typed_config: {
        "@type": "type.googleapis.com/envoy.extensions.filters.http.compressor.v3.Compressor",
        // Client q-values take precedence; prefer Brotli for ties.
        choose_first: name === "brotli",
        response_direction_config: {
          common_config: { min_content_length: 1024, content_type: contentTypes },
          remove_accept_encoding_header: false,
          // Range bytes describe the original representation. Never transform them.
          uncompressible_response_codes: [206],
        },
        compressor_library: {
          name: `envoy.compression.${name}.compressor`,
          typed_config: {
            "@type": `type.googleapis.com/envoy.extensions.compression.${name}.compressor.v3.${type}`,
            ...config,
          },
        },
      },
    };
    if (name !== "zstd") return filter;
    // Envoy 1.38's Zstd compressor uses ZSTD_e_continue for every non-final chunk,
    // never ZSTD_e_flush. Unknown-length responses must bypass it or RSC/HTML stalls.
    // A skipped selected codec falls back to identity; the request headers stay intact.
    return {
      name: filter.name,
      typed_config: {
        "@type": "type.googleapis.com/envoy.extensions.common.matching.v3.ExtensionWithMatcher",
        extension_config: filter,
        xds_matcher: {
          matcher_list: {
            matchers: [
              {
                predicate: {
                  not_matcher: {
                    single_predicate: {
                      input: {
                        name: "envoy.matching.inputs.response_headers",
                        typed_config: {
                          "@type":
                            "type.googleapis.com/envoy.type.matcher.v3.HttpResponseHeaderMatchInput",
                          header_name: "content-length",
                        },
                      },
                      value_match: { safe_regex: { google_re2: {}, regex: "[0-9]+" } },
                    },
                  },
                },
                on_match: {
                  action: {
                    name: "skip",
                    typed_config: {
                      "@type":
                        "type.googleapis.com/envoy.extensions.filters.common.matcher.action.v3.SkipFilter",
                    },
                  },
                },
              },
            ],
          },
        },
      },
    };
  });
}

/** No ext_proc here: the edge or pool already owns middleware. This proxy only compresses. */
export function compressionProxyConfig(upstreamPort: number, listenPort = 3000) {
  return {
    admin: { address: { socket_address: { address: "127.0.0.1", port_value: 9901 } } },
    static_resources: {
      listeners: [
        {
          name: "compression",
          address: { socket_address: { address: "0.0.0.0", port_value: listenPort } },
          filter_chains: [
            {
              filters: [
                {
                  name: "envoy.filters.network.http_connection_manager",
                  typed_config: {
                    "@type":
                      "type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager",
                    stat_prefix: "compression",
                    server_header_transformation: "PASS_THROUGH",
                    // A second proxy must not change the request signed by ext_proc.
                    normalize_path: false,
                    merge_slashes: false,
                    path_with_escaped_slashes_action: "KEEP_UNCHANGED",
                    use_remote_address: false,
                    skip_xff_append: true,
                    generate_request_id: false,
                    preserve_external_request_id: true,
                    // HCM otherwise invents X-Forwarded-Proto when absent, invalidating a
                    // signed request. Prefix ONLY existing values before HCM runs, then
                    // restore them in the first filter. The prefix also distinguishes an
                    // explicitly empty header from an absent one, without a spoofable flag.
                    early_header_mutation_extensions: [
                      {
                        name: "envoy.http.early_header_mutation.header_mutation",
                        typed_config: {
                          "@type":
                            "type.googleapis.com/envoy.extensions.http.early_header_mutation.header_mutation.v3.HeaderMutation",
                          mutations: [
                            {
                              append: {
                                header: {
                                  key: "x-forwarded-proto",
                                  value: "v%REQ(x-forwarded-proto)%",
                                },
                                append_action: "OVERWRITE_IF_EXISTS",
                              },
                            },
                          ],
                        },
                      },
                    ],
                    upgrade_configs: [{ upgrade_type: "websocket" }],
                    route_config: {
                      name: "pool",
                      virtual_hosts: [
                        {
                          name: "pool",
                          domains: ["*"],
                          routes: [
                            {
                              match: { prefix: "/" },
                              route: { cluster: "pool", timeout: "0s" },
                            },
                          ],
                        },
                      ],
                    },
                    http_filters: [
                      {
                        name: "envoy.filters.http.lua",
                        typed_config: {
                          "@type": "type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua",
                          // The single upstream is fixed; restoring an absent XFP must not
                          // make Envoy reselect a route (its route matcher requires XFP).
                          clear_route_cache: false,
                          default_source_code: {
                            inline_string: `function envoy_on_request(handle)
  local headers = handle:headers()
  local proto = headers:get("x-forwarded-proto")
  if proto and string.sub(proto, 1, 1) == "v" then
    proto = string.sub(proto, 2)
    headers:replace("x-forwarded-proto", proto)
    if proto == "http" or proto == "https" then headers:replace(":scheme", proto) end
  else
    headers:remove("x-forwarded-proto")
  end
end
`,
                          },
                        },
                      },
                      ...compressionFilters(),
                      {
                        name: "envoy.filters.http.router",
                        typed_config: {
                          "@type":
                            "type.googleapis.com/envoy.extensions.filters.http.router.v3.Router",
                          suppress_envoy_headers: true,
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
      clusters: [
        {
          name: "pool",
          type: "STATIC",
          connect_timeout: "5s",
          load_assignment: {
            cluster_name: "pool",
            endpoints: [
              {
                lb_endpoints: [
                  {
                    endpoint: {
                      address: {
                        socket_address: { address: "127.0.0.1", port_value: upstreamPort },
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    },
  };
}
