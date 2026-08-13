# The in-cluster cutover Job's image (`cutover.mode: job` — see docs/gitops.md).
#
# Build from the REPO ROOT after `npm run build` (dist/cutover-job.cjs must exist):
#
#   npm run build
#   docker build -f docker/cutover-job.Dockerfile -t <registry>/adapter-k8s-cutover:<version> .
#   docker push <registry>/adapter-k8s-cutover:<version>
#
# Then pass the pushed image — BY DIGEST — to `emit --cutover job` via `--cutover-image`
# (or ADAPTER_K8S_CUTOVER_IMAGE); emit refuses un-digested refs and writes the ref into
# the bundle values. A digest pin is what makes the promotion reproducible (the same
# discipline emit applies to every other image).
#
# glibc base, NOT alpine: the dl.k8s.io kubectl release binaries are glibc-linked and
# fail to exec on musl.
FROM node:22-slim
ARG TARGETARCH=amd64
# kubectl only talks to the pod's own apiserver via the Job's ServiceAccount. Keep the
# minor version within one of your cluster's (the Kubernetes version-skew policy).
ARG KUBECTL_VERSION=v1.31.5
ADD --chmod=755 https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl /usr/local/bin/kubectl
COPY dist/cutover-job.cjs /cutover-job.cjs
# The Job template mounts an emptyDir at /tmp and runs readOnlyRootFilesystem; pointing
# HOME there keeps kubectl's discovery cache off the read-only root.
ENV HOME=/tmp
USER 1000
ENTRYPOINT ["node", "/cutover-job.cjs"]
