# The in-cluster cutover Job's image (`cutover.mode: job` — see docs/gitops.md).
#
# Build from the REPO ROOT after `npm run build` (dist/cutover-job.cjs must exist):
#
#   npm run build
#   docker build --platform=linux/amd64 --build-arg KUBECTL_VERSION=v1.35.7 \
#     -f docker/cutover-job.Dockerfile -t <registry>/adapter-k8s-cutover:<version> .
#   docker push <registry>/adapter-k8s-cutover:<version>
#
# Then pass the pushed image — BY DIGEST — to `emit --cutover job` via `--cutover-image`
# (or ADAPTER_K8S_CUTOVER_IMAGE); emit refuses un-digested refs and writes the ref into
# the bundle values. A digest pin is what makes the promotion reproducible (the same
# discipline emit applies to every other image).
#
FROM node:22-slim AS kubectl-download
ARG TARGETARCH=amd64
# No universal default can be correct: kubectl is supported only within one minor of the
# apiserver, and this package targets multiple Kubernetes minors. Make the operator name the
# version deliberately instead of silently baking a stale client into a privileged cutover Job.
ARG KUBECTL_VERSION
RUN test -n "${KUBECTL_VERSION}" || (echo >&2 "KUBECTL_VERSION is required (for example v1.35.7); choose a kubectl release within one minor of the target API server"; exit 1)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" \
    && curl -fsSLo /tmp/kubectl.sha256 "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl.sha256" \
    && echo "$(cat /tmp/kubectl.sha256)  /usr/local/bin/kubectl" | sha256sum --check \
    && chmod 0755 /usr/local/bin/kubectl

# glibc base, NOT alpine: the dl.k8s.io kubectl release binaries are glibc-linked and
# fail to exec on musl. The downloader's curl/apt state never reaches the runtime image.
FROM node:22-slim
COPY --from=kubectl-download /usr/local/bin/kubectl /usr/local/bin/kubectl
COPY dist/cutover-job.cjs /cutover-job.cjs
# The Job template mounts an emptyDir at /tmp and runs readOnlyRootFilesystem; pointing
# HOME there keeps kubectl's discovery cache off the read-only root.
ENV HOME=/tmp
USER 1000
ENTRYPOINT ["node", "/cutover-job.cjs"]
