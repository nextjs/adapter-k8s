#!/usr/bin/env bash
set -euo pipefail

# Cluster-free schema gate. Versions and archive hashes are pinned so CI and local runs ask the
# same Helm and kubeconform questions. The test itself explicitly skips only the CRD kinds owned
# by Gateway API, Envoy Gateway, and GKE; every native Kubernetes resource is strict-validated.
HELM_VERSION="3.18.6"
KUBECONFORM_VERSION="0.7.0"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    platform="linux-amd64"
    helm_sha="3f43c0aa57243852dd542493a0f54f1396c0bc8ec7296bbb2c01e802010819ce"
    kubeconform_sha="c31518ddd122663b3f3aa874cfe8178cb0988de944f29c74a0b9260920d115d3"
    ;;
  Linux-aarch64 | Linux-arm64)
    platform="linux-arm64"
    helm_sha="5b8e00b6709caab466cbbb0bc29ee09059b8dc9417991dd04b497530e49b1737"
    kubeconform_sha="cc907ccf9e3c34523f0f32b69745265e0a6908ca85b92f41931d4537860eb83c"
    ;;
  Darwin-x86_64)
    platform="darwin-amd64"
    helm_sha="80cad0470e38cf25731cdead7c32dfbeb887bc177bd6fa01e31b065722f8f06b"
    kubeconform_sha="c6771cc894d82e1b12f35ee797dcda1f7da6a3787aa30902a15c264056dd40d4"
    ;;
  Darwin-arm64)
    platform="darwin-arm64"
    helm_sha="48e30d236a1f334c6acb78501be5a851eaa2a267fefeb1131b6484eb2f9f30d7"
    kubeconform_sha="b5d32b2cb77f9c781c976b20a85e2d0bc8f9184d5d1cfe665a2f31a19f99eeb9"
    ;;
  *)
    echo "Unsupported schema-tool platform: $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac

tool_dir="$(mktemp -d)"
trap 'rm -rf "${tool_dir}"' EXIT

verify_sha() {
  local expected="$1"
  local file="$2"
  local actual
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "${file}" | awk '{print $1}')"
  else
    actual="$(shasum -a 256 "${file}" | awk '{print $1}')"
  fi
  if [[ "${actual}" != "${expected}" ]]; then
    echo "Checksum mismatch for ${file}: expected ${expected}, got ${actual}" >&2
    exit 1
  fi
}

helm_archive="${tool_dir}/helm.tar.gz"
curl --fail --location --silent --show-error \
  "https://get.helm.sh/helm-v${HELM_VERSION}-${platform}.tar.gz" \
  --output "${helm_archive}"
verify_sha "${helm_sha}" "${helm_archive}"
tar -xzf "${helm_archive}" -C "${tool_dir}"
helm_bin="${tool_dir}/${platform}/helm"

kubeconform_archive="${tool_dir}/kubeconform.tar.gz"
curl --fail --location --silent --show-error \
  "https://github.com/yannh/kubeconform/releases/download/v${KUBECONFORM_VERSION}/kubeconform-${platform}.tar.gz" \
  --output "${kubeconform_archive}"
verify_sha "${kubeconform_sha}" "${kubeconform_archive}"
tar -xzf "${kubeconform_archive}" -C "${tool_dir}" kubeconform

ADAPTER_K8S_SCHEMA_HELM="${helm_bin}" \
ADAPTER_K8S_SCHEMA_KUBECONFORM="${tool_dir}/kubeconform" \
  npx vitest run --disableConsoleIntercept tests/emit/chart-schema.test.ts
