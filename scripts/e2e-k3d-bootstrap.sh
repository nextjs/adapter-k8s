#!/usr/bin/env bash
set -euo pipefail

# PHASE 2 bootstrap: a LOCAL Kubernetes cluster for running upstream Next.js e2e suites
# through the REAL production topology — Envoy Gateway → ext_proc routing service → pools —
# with the generic provider. This replaces the retired process-level Envoy emulation
# (e2e-integration-deploy.sh), which drifted for months and never produced a completed run.
#
# Idempotent: safe to re-run; recreates nothing that exists.
#
#   cluster:   k3d (k3s in docker) named "adapter-e2e", 1 server node
#   registry:  k3d-managed local registry on a fixed host port — image "push" is a local copy
#   gateway:   Envoy Gateway (className "eg"), HTTP exposed on localhost:${E2E_K3D_HTTP_PORT}
#   valkey:    single in-cluster pod + Service; shared across lanes safely because the
#              adapter namespaces every key by build id (k8s:<buildId>:)
#
# CORRECTION (2026-07-30, measured): k3s ENFORCES NetworkPolicy even under flannel — it
# ships a built-in kube-router-based netpol controller. Pilot 3 proved it the hard way:
# the merged Envoy proxy (owned by the GatewayClass, so unmatched by the per-gateway
# allowlist peer) was REFUSED by every pool and ext_proc port while the pods sat Ready.
# So Phase 2 exercises the strict allowlist for real; the earlier "decorative netpol"
# caveat here was wrong, in the good direction.

CLUSTER_NAME="${E2E_K3D_CLUSTER:-adapter-e2e}"
REGISTRY_NAME="${E2E_K3D_REGISTRY:-adapter-e2e-registry}"
REGISTRY_PORT="${E2E_K3D_REGISTRY_PORT:-5511}"
HTTP_PORT="${E2E_K3D_HTTP_PORT:-8788}"
ENVOY_GATEWAY_VERSION="${E2E_ENVOY_GATEWAY_VERSION:-v1.5.4}"

echo "=== Phase 2 local cluster bootstrap ==="

# DEDICATED kubeconfig — never the global one. A global `kubectl config use-context` here
# while a cloud deploy is mid-flight elsewhere cross-wires that deploy's later kubectl calls
# into this cluster. That is not hypothetical: it happened live on 2026-07-30 (attempt-5 of a
# GKE restore ran its helm upgrade against this k3d cluster; helm failed wholesale before
# creating anything, which is the only reason nothing leaked). Every kubectl in this script
# and in the Phase-2 harness goes through this file.
export KUBECONFIG="${E2E_K3D_KUBECONFIG:-$HOME/.kube/k3d-adapter-e2e.yaml}"

# --- 1. Registry ---
if ! k3d registry list 2>/dev/null | grep -q "k3d-${REGISTRY_NAME}"; then
  echo "→ Creating local registry k3d-${REGISTRY_NAME}:${REGISTRY_PORT}"
  k3d registry create "${REGISTRY_NAME}" --port "127.0.0.1:${REGISTRY_PORT}"
else
  echo "→ Registry k3d-${REGISTRY_NAME} exists"
fi

# --- 2. Cluster ---
if ! k3d cluster list 2>/dev/null | grep -q "^${CLUSTER_NAME}"; then
  echo "→ Creating cluster ${CLUSTER_NAME} (HTTP on localhost:${HTTP_PORT})"
  # --k3s-arg disables Traefik (Envoy Gateway is the ingress under test — two ingresses
  # fight over ports and confuse the topology). The port mapping exposes the Envoy Gateway
  # service via the k3d loadbalancer once the Gateway's Service is of type LoadBalancer.
  # registries.yaml: containerd inside the node must resolve `localhost:${REGISTRY_PORT}`
  # (the SAME name the host pushes to and the chart bakes into image references) to the
  # registry container. `--registry-use` alone only wires the registry's cluster-network
  # name — measured: every pull of localhost:5511/... died with "dial tcp [::1]:5511:
  # connect: connection refused" against the node's own loopback.
  REG_CONF="$(mktemp)"
  cat > "$REG_CONF" <<EOF
mirrors:
  "localhost:${REGISTRY_PORT}":
    endpoint:
      # :5000, not :${REGISTRY_PORT} — the registry container LISTENS on 5000 in-network;
      # ${REGISTRY_PORT} is only the host-side mapping (127.0.0.1:${REGISTRY_PORT}->5000).
      # Measured: the ${REGISTRY_PORT} endpoint refused every in-cluster pull.
      - http://k3d-${REGISTRY_NAME}:5000
EOF
  # --kubeconfig-*=false: cluster create must NOT merge into or switch the global
  # kubeconfig — that is the cross-wire vector the dedicated KUBECONFIG above exists to
  # close, and create's default behavior would reopen it on every fresh bootstrap.
  k3d cluster create "${CLUSTER_NAME}" \
    --registry-use "k3d-${REGISTRY_NAME}:${REGISTRY_PORT}" \
    --registry-config "$REG_CONF" \
    --port "${HTTP_PORT}:80@loadbalancer" \
    --k3s-arg "--disable=traefik@server:0" \
    --kubeconfig-update-default=false \
    --kubeconfig-switch-context=false \
    --wait
  rm -f "$REG_CONF"
else
  echo "→ Cluster ${CLUSTER_NAME} exists"
fi
k3d kubeconfig get "${CLUSTER_NAME}" > "$KUBECONFIG"
chmod 600 "$KUBECONFIG"
kubectl wait --for=condition=Ready node --all --timeout=120s >/dev/null

# --- 3. Envoy Gateway ---
if ! kubectl get deploy -n envoy-gateway-system envoy-gateway >/dev/null 2>&1; then
  echo "→ Installing Envoy Gateway ${ENVOY_GATEWAY_VERSION}"
  helm install eg oci://docker.io/envoyproxy/gateway-helm \
    --version "${ENVOY_GATEWAY_VERSION#v}" \
    -n envoy-gateway-system --create-namespace --wait
else
  echo "→ Envoy Gateway present"
fi
# GatewayClass "eg" — the className the generic provider config expects.
# mergeGateways: every lane's release creates its OWN Gateway object, but only ONE proxy
# data plane (and one LoadBalancer service) exists, so k3d's single 8788:80 port mapping
# serves every lane by Host routing. Without merging, each Gateway spawns its own proxy
# and its own LB service, and klipper-lb can bind :80 exactly once per node — lane 2's
# Gateway would sit Pending forever.
kubectl apply -f - >/dev/null <<'EOF'
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: merged-lanes
  namespace: envoy-gateway-system
spec:
  mergeGateways: true
---
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: eg
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
  parametersRef:
    group: gateway.envoyproxy.io
    kind: EnvoyProxy
    name: merged-lanes
    namespace: envoy-gateway-system
EOF

# --- 4. Valkey ---
if ! kubectl get deploy e2e-valkey >/dev/null 2>&1; then
  echo "→ Deploying Valkey"
  kubectl apply -f - >/dev/null <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: e2e-valkey
  labels: { app: e2e-valkey }
spec:
  replicas: 1
  selector: { matchLabels: { app: e2e-valkey } }
  template:
    metadata: { labels: { app: e2e-valkey } }
    spec:
      containers:
        - name: valkey
          image: valkey/valkey:8-alpine
          ports: [{ containerPort: 6379 }]
          resources:
            requests: { cpu: 100m, memory: 256Mi }
            limits: { memory: 2Gi }
---
apiVersion: v1
kind: Service
metadata:
  name: e2e-valkey
spec:
  selector: { app: e2e-valkey }
  ports: [{ port: 6379, targetPort: 6379 }]
EOF
  kubectl rollout status deploy/e2e-valkey --timeout=180s >/dev/null
else
  echo "→ Valkey present"
fi

echo ""
echo "=== Ready ==="
echo "kubeconfig: ${KUBECONFIG} (dedicated; global context untouched)"
echo "registry:  localhost:${REGISTRY_PORT}  (in-cluster: k3d-${REGISTRY_NAME}:${REGISTRY_PORT})"
echo "gateway:   http://<hostname>.localhost:${HTTP_PORT} (Host-routed)"
echo "valkey:    redis://e2e-valkey.default.svc.cluster.local:6379"
