# Contributing

The adapter is experimental and correctness-first. A change is ready when its failure behavior is bounded and tested. Throughput work comes later.

## Before editing

Run the focused test for the module you plan to change. For a bug with a cheap local reproduction, add the failing regression test first. Preserve comments that name an upstream Next.js behavior or a past incident. They explain constraints that are otherwise easy to remove by accident.

Use the existing target seams for Kubernetes integrations:

| Concern                                               | Interface                 | Examples                                               |
| ----------------------------------------------------- | ------------------------- | ------------------------------------------------------ |
| cluster access, identity, registry, network discovery | `defineClusterComponent`  | kubeconfig, GKE                                        |
| incoming traffic and TLS attachment                   | `defineExposureComponent` | Gateway API, shared HTTPRoute, Ingress                 |
| Next.js routing location                              | `defineRoutingComponent`  | portable origin, Envoy ext_proc, GKE traffic extension |
| adapter-owned dependencies and policy objects         | `defineResourceComponent` | a future managed cache component                       |

Do not add another `provider` value. `provider.gke` and `provider.generic` are legacy inputs supported through 0.x. New cluster support must remain independent from registry, exposure, routing, and managed-resource choices. That is why adding AWS support later should not imply ECR, ALB, Route 53, or ElastiCache today.

## Routing integrations

Read [Writing a routing adapter](./docs/targets.md#writing-a-routing-adapter) before adding controller-specific code. Ingress support and native routing are different jobs. For example, ingress-nginx works today as `ingressExposure({ className: "nginx" })` with portable routing. It should only gain a native routing component if the controller has a real pre-origin hook that can preserve the adapter's dispatch and failure contracts.

Keep controller-specific Kubernetes objects, API requirements, readiness checks, and diagnostics in the component that owns them. The target compiler must remain free of controller-name branches.

## Required checks

Run these before considering a change complete:

```bash
npm test
npx tsc --noEmit
npm run lint
```

Run `npm run build` when exports, generated bundles, package types, or protobuf consumers change. Do not run the live GKE suite casually. The local e2e harness takes about 16 to 17 minutes with its default concurrency and a pinned Next.js ref.

Every new routing adapter needs compiler tests plus live controller evidence. Record the tested Kubernetes, controller, CRD, and CNI versions in [docs/verification.md](./docs/verification.md). Include failure-policy, request-body, streaming, readiness, cleanup, and middleware-bypass checks.
