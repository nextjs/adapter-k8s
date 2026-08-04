# AGENTS.md

## What this is

`@next-community/adapter-k8s` — a Next.js adapter (Next 16.3+ `adapterPath` API) that deploys
Next.js apps to GKE. At build time it analyzes the route structure and generates pool servers, an
ext_proc routing service, a Helm chart, and Dockerfiles. A CLI (`adapter-k8s`) provisions GCP
infrastructure and runs zero-downtime blue/green deploys.

Status: **experimental, correctness-first** ("make it work, make it correct, make it fast" — fast
is deliberately last). Favor correct, bounded behavior over throughput.

## Commands

- `npm run build` — clean + declaration types + esbuild bundles (adapter, pool-server,
  cache-handler, routing-service, cli) + buf proto codegen
- `npm test` — unit tests (vitest; hermetic — Docker-gated integration tests skip without Docker)
- `npm run test:e2e` — local e2e harness (`scripts/e2e-local.sh`). **A full run should take
  ~16-17 min. If it doesn't, the invocation is wrong:** the script auto-builds+packs the
  adapter ONCE and exports `ADAPTER_K8S_PREBUILT_TARBALL` (never let per-deploy rebuilds
  happen), and concurrency comes from `NEXT_TEST_CONCURRENCY` (default 4 — do NOT raise it;
  c=16 was measured to produce ~205 browser/image contention failures on this machine).
  Pin the Next ref explicitly (2nd arg) — see the run-mechanics section of the
  project_e2e_run_baseline memory for known-bad refs and flake buckets before triaging
  failures. Never edit src/ or scripts/ while a run is in flight (deploys re-pack from the
  working tree).
- `npm run test:e2e:live` (and per-fixture variants) — live e2e against real GKE; needs env vars
  and deployed fixtures. Don't run casually.
- `npm run lint` / `npm run fmt` — oxlint / oxfmt
- `npx tsc --noEmit` — typecheck

Run `npm test` and `npx tsc --noEmit` before considering any change done.

## Repo map (the interesting parts)

- `src/adapter.ts` — adapter entry. `modifyConfig` (K8s-safe buildId, immutable assets, Valkey
  cache-handler registration) and `onBuildComplete` (classify → manifests → Helm chart → Docker
  contexts). The staging machinery (`stageFile`, symlink dereferencing, monorepo asset rebasing)
  lives here.
- `src/classify.ts` / `src/manifest.ts` / `src/cel.ts` / `src/extension-chain.ts` — build-time
  route→pool classification, routing manifest, CEL match condition for the traffic extension, and
  the extension-chain JSON.
- `src/emit/` — Helm chart templates (`templates/*.ts`, plain TS string builders, not Go
  templating), Dockerfiles, static-asset manifest, `.dockerignore`. Input sanitizers
  (`assertSafe*`) live in `templates/utils.ts`.
- `src/cli/` — init / deploy / rollback / destroy / doctor / emulate / describe / tail. **All**
  shell-outs go through `exec.ts` (execFile-style, `shell: false` — keep it that way). Deploy
  state (current/previous build) is in `state.ts` (local file + cluster ConfigMap).
- `src/pool-server/` — the per-pod Node server: loads Next build outputs via `import()`, serves
  static/public files, PPR shell resume, ISR, `/_next/image`, cross-pool proxying. `dispatch.ts`
  is the heart; `resolve.ts` runs `@next/routing` locally as the fail-safe path.
- `src/routing-service/` — ext_proc server (HTTP/2 + TLS via connectrpc) that runs
  middleware/rewrites/redirects at the load balancer. `protos/` is generated — regenerate with
  `npm run build:protos`, never hand-edit.
- `src/pool-server/valkey-cache/` — deliberately zero-dep RESP2 client + `use cache` handler +
  incremental cache handler + shared tag manifest (cross-replica `revalidateTag`).
- `fixtures/` — Next.js test apps (main, pages, edge, i18n-rewrite, interception, ws-canary).
- `tests/` — vitest suites. **`test/` (singular) is different**: deploy-test manifests for the
  e2e shell scripts.
- `plans/adapter-gke-design-doc.md` — the design doc. `docs/` and `reports/` are gitignored.

## Conventions

- ESM source with `.js` suffixes on relative imports; bundles built with esbuild. Package is
  `"type": "module"`.
- Comments explain _why_, often referencing past incidents or upstream Next.js behavior (tags
  like `L13`, `M4a`, "H2"). Keep them; add to them when fixing edge cases — they are the
  institutional memory of this repo.
- Minimal runtime dependencies by design (the RESP client is zero-dep on purpose).
- **Validate at the point of consumption.** Any value that is operator/build-controlled (build
  id, release name, hostnames, registry, namespace, pool names, project/region) must pass the
  `assertSafe*` validators in `src/emit/templates/utils.ts` before reaching YAML, CEL,
  `helm --set`, or shell argv — even if it was validated upstream.
- **Secrets**: never on argv, never in logs; secret-bearing files are written mode `0600`;
  `.k8s-adapter/` must stay gitignored (init scaffolds this).
- **Dataplane error handling**: fail open to cache-miss / local re-resolution; fail closed on
  auth (middleware throw → 500, never bypass middleware).

## Invariants that must hold

1. **Fail-safe layering.** A request reaching a pool without trusted dispatch headers gets full
   local resolution (middleware still runs). Client-supplied `x-*` dispatch headers are never
   trusted without the internal secret (timing-safe compare, deleted before handlers see them).
2. **Middleware is never bypassed.** CDN must not cache middleware-covered routes (pool sends
   `Cache-Control: no-cache`); ext*proc failure mode is \_closed* when the app has middleware.
3. **Blue/green ordering.** Active Service selectors are patched only after every new pod is
   verified serving on `/healthz`; the previous build is kept at 0 replicas; deploy state is
   committed only after cutover. The selector value comes from the same sanitizer that stamps the
   pod label (a mismatch drains the Service to zero endpoints).
4. **Parity with `next start`.** `routing-common.ts` helpers are pinned to empirically verified
   upstream behavior — the tests document this. Don't regress it; verify against the real
   `@next/routing` (see `tests/pool-server/resolve-real-routing.test.ts`).
5. **Clean chart regeneration.** The generated chart dir is wiped each build so removed
   pools/builds can't leave stale templates that `helm upgrade` would re-apply.
6. **Kubectl context pinning.** CLI commands that touch the cluster run
   `gcloud container clusters get-credentials` first, _before_ reading cluster state (destroy
   historically missed this — don't reintroduce that class of bug).

## Testing

- Unit tests are hermetic: localhost-only sockets, `mkdtemp` tmp dirs, env save/restore around
  mutations. Keep them that way.
- `*.integration.test.ts` need Docker (ephemeral Valkey) and skip cleanly otherwise.
- CLI tests mock `exec.js` — see `tests/cli/rollback.test.ts` for the pattern.
- Live e2e (`vitest.e2e-live.config.ts`) runs against real GCP deployments gated on per-fixture
  env vars.
