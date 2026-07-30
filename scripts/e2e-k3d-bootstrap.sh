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
# KNOWN LIMIT, on purpose: k3d's default CNI (flannel) ACCEPTS NetworkPolicies but does not
# ENFORCE them, so the strict ingress allowlist is decorative here. Fine for framework
# conformance — enforcement is proven live on Cilium (Scaleway) — but Phase 2 results must
# never be cited as evidence for the security posture.

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
  # --kubeconfig-*=false: cluster create must NOT merge into or switch the global
  # kubeconfig — that is the cross-wire vector the dedicated KUBECONFIG above exists to
  # close, and create's default behavior would reopen it on every fresh bootstrap.
  k3d cluster create "${CLUSTER_NAME}" \
    --registry-use "k3d-${REGISTRY_NAME}:${REGISTRY_PORT}" \
    --port "${HTTP_PORT}:80@loadbalancer" \
    --k3s-arg "--disable=traefik@server:0" \
    --kubeconfig-update-default=false \
    --kubeconfig-switch-context=false \
    --wait
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
kubectl apply -f - >/dev/null <<'EOF'
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: eg
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
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
