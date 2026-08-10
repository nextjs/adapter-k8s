// src/pipeline/digests.ts
//
// Pipeline-safe registry digest resolution (deploy inventory A8): pin every image the
// release will run to an immutable digest, or refuse. Extracted from src/cli/deploy.ts for
// GitOps PR1 — `emit` runs the same fail-closed resolution in CI and writes the digests
// into values/values.yaml; imperative deploy consumes them unchanged. These functions talk
// to registries (and, docker-only, the local daemon) — never to a cluster.
import { execCapture, EXEC_TIMEOUTS } from "../cli/exec.js";
import type { RegistryDigestLookup } from "../composition-plan/index.js";
import { parseTargetPlatform, targetPlatform, type TargetPlatform } from "../target-platform.js";

export const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

/**
 * S23: pin every deployed image to an immutable digest, or refuse the deploy.
 *
 * Two sources, local first (fast, offline) then the registry (authoritative). If an image
 * still cannot be pinned this THROWS, because the alternative is deploying the mutable
 * `:${buildId}` tag on pods that receive the internal dispatch secret and the cache
 * credentials. A registry writer who retags that tag then changes the code running on the
 * next pod start or scale-up, which is exactly the escalation the split `<release>-cli`
 * identity exists to prevent (it is deliberately writer, not repoAdmin, for this reason).
 * Degrading to that silently on a `docker inspect` quirk gives the quirk the same effect
 * as the attack.
 *
 * S7 (SECURITY): the deploy identity's registry write access is assumable by anyone who can
 * create a Pod in the namespace (Workload Identity), while the pods themselves carry
 * INTERNAL_HEADER_SECRET and the cache credentials in env — so a retag of an already-deployed
 * build id turns pod-creation into dispatch-secret theft, and from there into a cluster-wide
 * middleware bypass. `docker inspect` reports RepoDigests only AFTER a successful push (the
 * digest is assigned by the registry), which is why this runs here and not at
 * chart-generation time.
 *
 * `--allow-mutable-tags` is the explicit opt-out, mirroring `--allow-no-network-policy`:
 * fail-closed by default, and an operator who really wants it has to say so.
 */
export async function resolveDeployImageDigests(opts: {
  refs: Array<[string, string]>;
  projectId: string;
  allowMutableTags?: boolean;
  containerCli?: string;
  targetPlatform?: TargetPlatform;
  digestLookup?: RegistryDigestLookup;
}): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  const unresolved: string[] = [];
  const cliLabel = opts.containerCli ?? "docker";
  const platform = parseTargetPlatform(
    opts.targetPlatform ?? targetPlatform(),
    "image digest target platform",
  );
  for (const [key, ref] of opts.refs) {
    // REGISTRY FIRST, on ANY registry (S25/S28). kubelet pulls from the registry, so only the
    // registry's digest can actually be deployed; the local daemon merely usually agrees, and
    // podman measurably does not. Artifact Registry is asked through gcloud (proven, and works
    // with the credential helper); everything else through crane/skopeo/docker-manifest.
    const cli = opts.containerCli ?? "docker";
    // The local daemon is the LAST resort, and only for docker. MEASURED with podman 6.0.1:
    // its RepoDigest matched the registry for one image and differed for another, because push
    // can rewrite the manifest. An unreliable digest is worse than none — it deploys and then
    // ImagePullBackOffs at rollout, after cutover has started, whereas refusing fails at deploy
    // time with something actionable.
    const artifactRegistryProject =
      opts.digestLookup?.kind === "gcp-artifact-registry"
        ? opts.digestLookup.projectId
        : opts.digestLookup?.kind === "oci-distribution"
          ? null
          : opts.projectId;
    // Single-flight for the crane/skopeo/docker-manifest chain: resolveRegistryDigest ends
    // by running it, and the `??` fallback used to run the IDENTICAL chain a second time
    // whenever the first came back null — doubled subprocess latency on exactly the slow
    // path (no crane/skopeo installed). Memoizing keeps the gcloud-failed case (where the
    // chain has NOT run yet) probing exactly once.
    let anyProbePromise: Promise<string | null> | undefined;
    const probeAny = () => (anyProbePromise ??= resolveRegistryDigestAny(ref, cli, platform));
    const digest =
      (artifactRegistryProject !== null
        ? await resolveRegistryDigest(ref, artifactRegistryProject, platform, cli, probeAny)
        : null) ??
      (await probeAny()) ??
      (cli === "docker" ? await resolveImageDigest(ref, cli, platform) : null);
    if (digest) digests[key] = digest;
    else unresolved.push(ref);
  }
  if (unresolved.length > 0) {
    if (!opts.allowMutableTags) {
      throw new Error(
        `Could not resolve an immutable digest for: ${unresolved.join(", ")}. No registry probe ` +
          `could pin these images, so deploying would run them by TAG — a retag would change ` +
          `what runs on the next pod start, on pods that hold the internal dispatch secret and ` +
          `cache credentials. Refusing to deploy without image integrity.\n` +
          `Fix registry access for a platform-aware client (\`crane\`, \`skopeo\`, or ` +
          `\`docker manifest inspect\`). An Artifact Registry summary digest alone is not ` +
          `enough because it may name an index with no ${platform} child.\n` +
          `Note: the local ${cliLabel} daemon is only trusted as a digest source for docker — ` +
          `podman rewrites manifests on push, so its local digest can differ from the registry's ` +
          `and deploying it fails at rollout. Pass --allow-mutable-tags to deploy anyway.`,
      );
    }
    console.warn(
      `\n  ! Could not resolve an immutable digest for: ${unresolved.join(", ")}.\n` +
        `    Deploying these by TAG (--allow-mutable-tags), so a retag would change what runs ` +
        `on the next pod start.`,
    );
  }
  return digests;
}

/**
 * S28: resolve an image's digest from ANY registry — ECR, ACR, Harbor, Docker Hub, or a
 * self-hosted one.
 *
 * `resolveRegistryDigest` below speaks only to Artifact Registry via gcloud, so every non-GCP
 * registry fell through to the LOCAL daemon. That is the exact path podman gets wrong: its
 * `RepoDigest` describes the local copy, and podman rewrites the manifest on push, so deploying
 * that value yields ImagePullBackOff (measured: podman said e04a0a5b…, the registry held
 * 27fa476b…). Shipping EKS/AKS on the local-daemon fallback would inherit a known-broken path.
 *
 * Probe order, first platform-validated answer wins:
 *  1. `crane manifest/config/digest` — inspect the index or single-image config before digest.
 *  2. `skopeo inspect --override-*` — require its selected image to report the target platform.
 *  3. `docker manifest inspect -v` — needs NO extra tooling, and VERIFIED against Artifact
 *     Registry to report a digest byte-identical to `gcloud artifacts docker images describe`.
 *     Docker-only: nerdctl has no such subcommand, and podman's `manifest inspect` operates on
 *     manifest lists it manages locally rather than querying a remote registry.
 *
 * Returns null (never throws) so the caller owns the fail-closed decision.
 */
export async function resolveRegistryDigestAny(
  imageRef: string,
  containerCli: string,
  platform: TargetPlatform = targetPlatform(),
): Promise<string | null> {
  const safePlatform = parseTargetPlatform(platform, "registry digest target platform");
  const [targetOs, targetArch, targetVariant] = safePlatform.split("/");
  const matches = (candidate: {
    os?: string | undefined;
    architecture?: string | undefined;
    variant?: string | undefined;
  }) =>
    candidate.os === targetOs &&
    candidate.architecture === targetArch &&
    (candidate.variant ?? undefined) === (targetVariant ?? undefined);

  const craneManifest = await execCapture("crane", ["manifest", imageRef], {
    timeoutMs: EXEC_TIMEOUTS.kubectl,
  }).catch(() => null);
  if (craneManifest?.exitCode === 0) {
    try {
      const manifest = JSON.parse(craneManifest.stdout) as {
        manifests?: Array<{
          digest?: string;
          platform?: { os?: string; architecture?: string; variant?: string };
        }>;
      };
      if (Array.isArray(manifest.manifests)) {
        const child = manifest.manifests.find((entry) => entry.platform && matches(entry.platform));
        return child?.digest && DIGEST_RE.test(child.digest) ? child.digest : null;
      }

      // A single-image manifest has no platform field. Its config is the authoritative OS/arch.
      const config = await execCapture("crane", ["config", imageRef], {
        timeoutMs: EXEC_TIMEOUTS.kubectl,
      }).catch(() => null);
      if (config?.exitCode !== 0) return null;
      const imageConfig = JSON.parse(config.stdout) as {
        os?: string;
        architecture?: string;
        variant?: string;
      };
      if (!matches(imageConfig)) return null;
      const digest = await execCapture("crane", ["digest", imageRef], {
        timeoutMs: EXEC_TIMEOUTS.kubectl,
      }).catch(() => null);
      const value = digest?.stdout.trim() ?? "";
      return digest?.exitCode === 0 && DIGEST_RE.test(value) ? value : null;
    } catch {
      // Malformed output is not proof of a platform; try the next independent probe.
    }
  }

  const skopeoArgs = [
    "inspect",
    "--override-os",
    targetOs!,
    "--override-arch",
    targetArch!,
    ...(targetVariant ? ["--override-variant", targetVariant] : []),
    `docker://${imageRef}`,
  ];
  const skopeo = await execCapture("skopeo", skopeoArgs, {
    timeoutMs: EXEC_TIMEOUTS.kubectl,
  }).catch(() => null);
  if (skopeo?.exitCode === 0) {
    try {
      const inspected = JSON.parse(skopeo.stdout) as {
        Digest?: string;
        Os?: string;
        Architecture?: string;
        Variant?: string;
      };
      if (
        !matches({
          os: inspected.Os,
          architecture: inspected.Architecture,
          variant: inspected.Variant,
        })
      ) {
        return null;
      }
      return inspected.Digest && DIGEST_RE.test(inspected.Digest) ? inspected.Digest : null;
    } catch {
      // Try docker's registry view when skopeo did not return usable JSON.
    }
  }

  if (containerCli === "docker") {
    const res = await execCapture("docker", ["manifest", "inspect", "-v", imageRef], {
      timeoutMs: EXEC_TIMEOUTS.kubectl,
    }).catch(() => null);
    if (res?.exitCode === 0) {
      try {
        const parsed: unknown = JSON.parse(res.stdout);
        // A SINGLE manifest comes back as one object carrying Descriptor.digest — that is the
        // digest to deploy, and it is the case verified against Artifact Registry.
        //
        // A manifest LIST (multi-arch) comes back as an ARRAY of per-platform entries. Taking
        // element [0] is WRONG: the order is the registry's, so an ARM-first list would pin the
        // arm64 child and the pods would die with `exec format error` on x86 nodes. The child's
        // digest is also not the digest of the index the tag points at. Since the platform we
        // deploy is fixed (see targetPlatform()), select the matching child explicitly and
        // refuse rather than guess when it is absent.
        if (Array.isArray(parsed)) {
          const match = parsed.find((entry) => {
            const p = (
              entry as {
                Descriptor?: {
                  platform?: { os?: string; architecture?: string; variant?: string };
                };
              }
            ).Descriptor?.platform;
            return !!p && matches(p);
          });
          const d = (match as { Descriptor?: { digest?: string } } | undefined)?.Descriptor?.digest;
          if (typeof d === "string" && DIGEST_RE.test(d)) return d;
          // No child for the platform we deploy: fall through to null so the caller fails
          // closed rather than pinning an image that cannot run.
          return null;
        }
        const descriptor = (
          parsed as {
            Descriptor?: {
              digest?: string;
              platform?: { os?: string; architecture?: string; variant?: string };
            };
          }
        )?.Descriptor;
        if (
          descriptor?.platform &&
          matches(descriptor.platform) &&
          typeof descriptor.digest === "string" &&
          DIGEST_RE.test(descriptor.digest)
        ) {
          return descriptor.digest;
        }
      } catch {
        // Unparseable output is not a digest; fall through to null.
      }
    }
  }

  return null;
}

/**
 * S23: resolve an image's digest from the REGISTRY, which is authoritative.
 *
 * `resolveImageDigest` below asks the local docker daemon, and that only knows a RepoDigest
 * when the push went through it — podman, buildx with certain drivers, or an image pushed by
 * something else all leave it empty. That used to degrade the deploy to a MUTABLE tag on pods
 * holding the internal dispatch secret, i.e. an ordinary tooling quirk quietly removed image
 * integrity. The image was just pushed, so ask the registry instead.
 *
 * VERIFIED live: `gcloud artifacts docker images describe` returned a byte-identical sha256 to
 * `docker inspect` for the same reference.
 *
 * Returns null (never throws) so the caller owns the fail-closed decision.
 */
export async function resolveRegistryDigest(
  imageRef: string,
  projectId: string,
  platform: TargetPlatform = targetPlatform(),
  containerCli: string = "docker",
  // Injectable so a caller that ALSO falls back to resolveRegistryDigestAny can share one
  // memoized probe instead of running the whole crane/skopeo/docker chain twice.
  probeAny: () => Promise<string | null> = () =>
    resolveRegistryDigestAny(imageRef, containerCli, platform),
): Promise<string | null> {
  // Artifact Registry only. Without a GCP project there is nothing to ask. The summary is a
  // useful authoritative existence/digest check, but it is never sufficient by itself because
  // an index digest does not prove that the requested platform is present.
  if (!projectId) return null;
  const res = await execCapture(
    "gcloud",
    [
      "artifacts",
      "docker",
      "images",
      "describe",
      imageRef,
      "--format=value(image_summary.digest)",
      `--project=${projectId}`,
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  if (res.exitCode !== 0) return null;
  const digest = res.stdout.trim();
  // Validated at the point of consumption: this string reaches a helm --set and then the pod
  // spec's image reference.
  if (!DIGEST_RE.test(digest)) return null;
  // Artifact Registry's summary digest can name an OCI INDEX and says nothing about which
  // children it contains. Never return it directly: a requested arm64 deploy previously
  // accepted an amd64-only index here before any platform-aware probe ran.
  return probeAny();
}

export async function resolveImageDigest(
  imageRef: string,
  containerCli: string = "docker",
  platform: TargetPlatform = targetPlatform(),
): Promise<string | null> {
  // ALL RepoDigests, not just index 0: they belong to the image ID, and one local image tagged
  // and pushed to more than one repository carries an entry per repository. Taking the first and
  // pairing its digest with THIS repository could reference a manifest that does not exist
  // there, leaving the new pods in ImagePullBackOff. Select the entry whose repository matches.
  // podman and nerdctl both implement `inspect --format` with the same Go template fields.
  const safePlatform = parseTargetPlatform(platform, "local image target platform");
  const res = await execCapture(
    containerCli,
    [
      "inspect",
      "--format",
      "{{.Os}}/{{.Architecture}}\n{{range .RepoDigests}}{{println .}}{{end}}",
      imageRef,
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  if (res.exitCode !== 0) return null;
  const [reportedPlatform, ...digestLines] = res.stdout.split("\n");
  if (reportedPlatform?.trim() !== safePlatform) return null;
  // The repository is the reference without its tag — `registry/host/repo:tag` → `…/repo`.
  // (A digest never appears here: this is the tag we just pushed.)
  const colon = imageRef.lastIndexOf(":");
  const slash = imageRef.lastIndexOf("/");
  const repository = colon > slash ? imageRef.slice(0, colon) : imageRef;
  const entries = digestLines.map((l) => l.trim()).filter(Boolean);
  for (const entry of entries) {
    const at = entry.lastIndexOf("@");
    if (at === -1) continue;
    if (entry.slice(0, at) !== repository) continue;
    const digest = entry.slice(at + 1);
    if (DIGEST_RE.test(digest)) return digest;
  }
  return null;
}
