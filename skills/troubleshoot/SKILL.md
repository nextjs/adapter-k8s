---
name: troubleshoot
description: adapter-k8s deployment diagnosis expert guidance. Use when debugging a deployed release — pods CrashLoopBackOff, 404s or wrong routing, middleware not running at the edge, cache not shared across replicas, NetworkPolicy not enforced, ImagePullBackOff, 503 from the load balancer, or failing doctor checks. Triggers on "why isn't my deploy working" and any adapter-k8s doctor FAIL output.
metadata:
  priority: 7
  docs:
    - "https://github.com/nextjs/adapter-k8s#readme"
  pathPatterns:
    - "adapter.config.*"
    - ".k8s-adapter/**"
  importPatterns:
    - "@next-community/adapter-k8s"
  bashPatterns:
    - '\badapter-k8s\s+doctor\b'
    - '\badapter-k8s\s+deploy\b'
    - '\badapter-k8s\s+rollback\b'
    - '\badapter-k8s\s+tail\b'
    - '\badapter-k8s\s+describe\b'
    - '\bnpx\s+adapter-k8s\b'
    - '\bkubectl\s+get\s+pods\b'
    - '\bkubectl\s+describe\s+(gateway|httproute|envoyextensionpolicy)\b'
  promptSignals:
    phrases:
      - "crashloopbackoff"
      - "imagepullbackoff"
      - "middleware not running"
      - "cache not shared"
      - "doctor fails"
      - "503 from the load balancer"
    allOf:
      - [deploy, broken]
      - [pods, crashing]
      - [routing, 404]
    anyOf:
      - "adapter-k8s"
      - "ext_proc"
      - "envoyextensionpolicy"
    noneOf:
      - "vercel deploy"
      - "terraform"
    minScore: 6
retrieval:
  aliases:
    - deployment debugging
    - doctor checks
    - release diagnosis
  intents:
    - diagnose a failing deploy
    - fix CrashLoopBackOff pods
    - fix middleware not running at the edge
    - fix shared cache misses
    - fix ImagePullBackOff
    - interpret doctor output
  entities:
    - adapter-k8s doctor
    - ext_proc
    - EnvoyExtensionPolicy
    - routing manifest
    - EXTERNAL_MANAGED
    - Valkey
    - NetworkPolicy
---

# Deployed Release Troubleshooting

You are a diagnosis orchestrator for @next-community/adapter-k8s releases. Do not guess from symptoms alone — run `npx adapter-k8s doctor` first, read its PASS/WARN/FAIL lines, and branch from there. Every FAIL prints a `Fix:` line; start with it. Ground claims in command output, never in what "should" be true.

## Rules

- **Doctor first, always.** It checks tools, `infrastructure.json`, `adapter.config.*`, deploy state, Gateway/HTTPRoute acceptance, per-pool Deployment health, active Service endpoints, pod logs, LB backend health, ext_proc wiring, and per-host DNS/TLS — in one pass. Exit code 1 means at least one FAIL.
- **Trust names, not labels.** Release name resolution is: `--release-name` flag → `releaseName` in `.k8s-adapter/infrastructure.json` → sanitized directory name. Running doctor from the wrong directory targets the wrong cluster (`e2e-cluster` vs `test-app-cluster`).
- **A "Deploy state" FAIL blocks deploy** — deploy refuses to run until cluster state is readable, because an unreadable state would look like a first deploy.
- **Never edit the `<release>-routing-manifest` ConfigMap or Service selectors by hand.** The routing pod refuses to start on a manifest that does not match its baked copy (fail-closed by design), and deploy/rollback patch Services by name because Helm rewrites the `managed-by` label.
- If a fix requires redeploying, re-run without `--skip-build` — the chart bakes registry, namespace, platform, and manifest at build time.

## Quick Start

```bash
# 1) Full health pass — every branch below starts here
npx adapter-k8s doctor

# 2) Live logs across all workloads (routing + pools)
npx adapter-k8s tail

# 3) Architecture diagram with live cluster status
npx adapter-k8s describe
```

## Decision Tree

Branch on the dominant symptom after reading doctor output:

- **Pods CrashLoopBackOff** ("Pod logs: Fatal error … Cannot find module") → [references/symptoms.md](references/symptoms.md) § CrashLoopBackOff
- **ImagePullBackOff / exec format error** → [references/symptoms.md](references/symptoms.md) § Image pull and platform
- **404s / wrong routing / rollback weirdness** ("Routing manifest mismatch" in routing pod logs) → [references/symptoms.md](references/symptoms.md) § Routing manifest vs build
- **Middleware not running** (middleware-set headers/rewrites absent; doctor "ext_proc traffic extension: FAIL" or deploy "EnvoyExtensionPolicy … is not Accepted") → [references/symptoms.md](references/symptoms.md) § Middleware / ext_proc
- **503 at the LB, pods green** ("Active Service endpoints: 0 ready") → [references/symptoms.md](references/symptoms.md) § Service selector drain
- **Cache not shared across replicas** (ISR/PPR revalidation only on one pod, MISS forever) → [references/symptoms.md](references/symptoms.md) § Shared cache
- **NetworkPolicy not enforced** (pool pod can reach `routing-service:8443`) → [references/symptoms.md](references/symptoms.md) § NetworkPolicy
- **DNS / TLS / cert stuck** (doctor per-host section) → the doctor `Fix:` lines are complete: A record to the printed Gateway IP, the printed CNAME for cert auth, and PROVISIONING can take up to 60 min.

## Reading Doctor Output

| Doctor check                | FAIL means                                                | First move                                                  |
| --------------------------- | --------------------------------------------------------- | ----------------------------------------------------------- |
| Composition target          | kubectl points at the wrong cluster                       | Restore access or rebuild for the intended cluster          |
| Deploy state                | cluster ConfigMap state unreadable                        | Fix cluster access; deploy is blocked until this passes     |
| Gateway / HTTPRoute         | Gateway API object not Accepted                           | `kubectl describe gateway <release>-gateway -n <ns>`        |
| Pool: `<name>`              | 0/N ready replicas                                        | `kubectl describe deployment/<name> -n <ns>`, then pod logs |
| Active Service endpoints    | selector matches no ready pods — origin 503s              | Check `app.kubernetes.io/version` selector vs pod labels    |
| ext_proc traffic extension  | edge middleware not wired (GKE)                           | `npx adapter-k8s deploy` — the traffic-ext Job registers it |
| routing backend scheme      | not EXTERNAL_MANAGED                                      | Delete the backend service, re-run init + deploy            |
| routing health check (WARN) | not TCP — gRPC passes plaintext but the TLS callout fails | Delete `<release>-routing-hc`, re-run init                  |
| Rollback ready (WARN)       | previous build's manifest was not retained                | Rollback would be image-only; see § Routing manifest        |
| LB health                   | current-build backends unhealthy                          | `gcloud compute backend-services get-health …` (printed)    |

Roles in the deployment list: no tag = current build, `[previous]` at 0/0 = rollback target (healthy state), `[old]` at 0/0 = pending cleanup, `[unknown]` = no version label.

## Verifying the Fix

After any remediation:

```bash
npx adapter-k8s doctor          # must exit 0
# Prove middleware ran at the edge: probe a response header YOUR middleware sets
# (the repo's e2e fixture stamps x-mw-executed; substitute your app's marker):
curl -sI https://<host>/ | grep -i <your-middleware-header>
```

`npx adapter-k8s emulate` reproduces the full Envoy → routing → pool path locally when you need to isolate cluster problems from build problems. `docs/verification.md` records what each verification layer can and structurally cannot see.
