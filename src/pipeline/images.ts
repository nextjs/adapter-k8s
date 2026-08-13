// src/pipeline/images.ts
//
// Pipeline-safe image steps (deploy inventory A6/A7): fetch-cache re-staging and the
// container build/push command plan. Extracted from src/cli/deploy.ts for GitOps PR1 —
// `emit` runs these in CI, where they touch only the local build output and the registry,
// never a cluster. Imperative deploy consumes them unchanged.
import path from "node:path";
import { createHash } from "node:crypto";
import { cpSync, existsSync, rmSync } from "node:fs";
import type { GcloudCommand } from "../cli/init.js";
import type { RegistryAuthentication } from "../composition-plan/index.js";
import { assertSafePoolName as assertSafePoolNameCharset } from "../emit/templates/utils.js";
import { parseTargetPlatform, targetPlatform, type TargetPlatform } from "../target-platform.js";
import {
  parsePoolImageLayout,
  SHARED_POOL_IMAGE_LAYOUT,
  type PoolImageLayout,
} from "../pool-image-layout.js";

export interface DockerCommandOptions {
  pools: string[];
  buildId: string;
  registry: string;
  outputDir: string;
  containerStrategy: "traced-assets" | "shared-image";
  poolImageLayout?: PoolImageLayout;
  /**
   * S24: which container CLI to shell out to. Defaults to docker for compatibility; the
   * deploy resolves the real one via resolveContainerCli(). Every verb used here — build,
   * push — is accepted identically by podman and nerdctl.
   */
  containerCli?: string;
  /** Platform recorded by the build artifact; never re-infer it from the deploy host. */
  targetPlatform?: TargetPlatform;
  /** Exact authentication operation declared by a composed target. Omitted for legacy builds. */
  registryAuthentication?: RegistryAuthentication;
  /** Portable routing has no routing-service workload or image. */
  includeRoutingService?: boolean;
}

/**
 * Re-stage the build's fetch-cache (`<distDir>/cache/fetch-cache`) into every image build
 * context, right before `docker build`.
 *
 * WHY HERE and not (only) in onBuildComplete: the fetch-cache entries are written
 * ASYNCHRONOUSLY by the static-export workers, and upstream orders nothing between those
 * writes and handleBuildComplete — the workers are only torn down in `next build`'s
 * `finally`, AFTER the adapter hook. Measured 2026-08-04: a local repro build staged the
 * dir fine (the write landed ~750ms before the staging read) while two consecutive harness
 * builds of the same fixture shipped images WITHOUT it — the write lost the race with
 * onBuildComplete's existsSync. Deploy runs minutes after the build, when the artifact is
 * deterministically on disk. The staged copy is REPLACED wholesale so entries deleted from
 * the build's fetch-cache stop shipping (the #32 context-wipe rule).
 *
 * The files matter because `next start`'s filesystem cache starts WITH them: without them a
 * post-revalidateTag FETCH read is a miss, patch-fetch re-fetches under the prerender's
 * abort signal, and the cache-components background revalidation dies under load
 * (rdc stale-forever — see build-seed-index.ts fetchCacheSeed).
 */
export function refreshFetchCacheStaging(
  projectDir: string,
  outputDir: string,
  metadata: {
    distDir?: unknown;
    pools: string[];
    containerStrategy: string;
    poolImageLayout?: unknown;
  },
): void {
  // Validate at the point of consumption: distDir comes from build-metadata.json, which is
  // build-controlled. The same escape S20 rejects at build time is rejected here — the dest
  // is built as `<context>/<distDir>` and a `../` form would land the recursive rm/cp
  // OUTSIDE the build context. Older metadata predates the field; default to .next.
  const distDirRel = typeof metadata.distDir === "string" ? metadata.distDir : ".next";
  if (path.isAbsolute(distDirRel) || distDirRel.split(path.sep).includes("..")) {
    throw new Error(
      `Invalid distDir ${JSON.stringify(distDirRel)} in build-metadata.json: it must be a ` +
        `project-relative path inside the project (S20). Re-run the build.`,
    );
  }
  const poolImageLayout = parsePoolImageLayout(metadata.poolImageLayout);
  if (poolImageLayout === SHARED_POOL_IMAGE_LAYOUT) {
    // An older CLI does not understand the layout: it refreshes every pool delta, then the
    // sentinel FROM fails. A retry with this CLI must remove those seeds because the child
    // COPY overlays its parent and would otherwise shadow every later base refresh.
    for (const pool of metadata.pools) {
      rmSync(path.join(outputDir, "pools", pool, "context", ".k8s-adapter", "fetch-cache-seed"), {
        recursive: true,
        force: true,
      });
    }
  }
  const src = path.join(projectDir, distDirRel, "cache", "fetch-cache");
  // Observable either way (M1 spirit): the silent-return variant of this function cost a
  // debugging round — an image shipped without the files and nothing said which of the two
  // silent paths (no source vs no re-stage) was taken.
  if (!existsSync(src)) {
    console.log(`    (no build fetch-cache at ${src} — nothing to re-stage)`);
    return;
  }
  const contexts =
    metadata.containerStrategy === "shared-image"
      ? [path.join(outputDir, "shared-context")]
      : poolImageLayout === SHARED_POOL_IMAGE_LAYOUT
        ? [path.join(outputDir, "pool-base", "fetch-cache")]
        : metadata.pools.map((pool) => path.join(outputDir, "pools", pool, "context"));
  for (const context of contexts) {
    // A context can legitimately be absent (ADAPTER_K8S_SKIP_STAGING builds have no
    // contexts, and those deploys never reach the docker step anyway).
    if (!existsSync(context)) continue;
    // NOT the runtime location: the pod mounts a writable emptyDir over /app/.next/cache
    // that shadows image content there; the pool server restores this seed at boot
    // (pool-server/fetch-cache-seed.ts).
    const dest = path.join(context, ".k8s-adapter", "fetch-cache-seed");
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true, dereference: true });
    console.log(`    Re-staged build fetch-cache into ${path.relative(projectDir, context)}`);
  }
}

export function buildDockerCommands(options: DockerCommandOptions): GcloudCommand[] {
  const { pools, buildId, registry, outputDir, containerStrategy } = options;
  const cli = options.containerCli ?? "docker";
  // S24: pin the build architecture. Without it a host-native build on Apple Silicon
  // produces arm64 images that fail with `exec format error` on GKE's x86 nodes — and only
  // at rollout, not at build time. Never passed to `push`, which has no such flag.
  const platformArg = `--platform=${parseTargetPlatform(
    options.targetPlatform ?? targetPlatform(),
    "Docker target platform",
  )}`;
  const commands: GcloudCommand[] = [];
  const poolImageLayout = parsePoolImageLayout(
    options.poolImageLayout,
    "Docker command poolImageLayout",
  );

  // 0. Registry authentication — ONLY for Google registries.
  //
  // This used to run `gcloud auth configure-docker` for every registry host unconditionally, so
  // a Harbor/ECR/ACR deploy with perfectly good credentials already configured died before it
  // built anything, on a machine that has no reason to have gcloud installed. Registry auth is
  // the registry's business: for anything non-Google we assume the operator's existing
  // credential setup (docker login, ECR credential helper, az acr login, a pull secret) — the
  // same assumption every other tool makes.
  const registryHost = registry.split("/")[0]!;
  const authentication = options.registryAuthentication;
  const shouldConfigureGcloud = authentication
    ? authentication.kind === "gcloud-docker-helper"
    : registryHost.endsWith("-docker.pkg.dev") || /(^|\.)gcr\.io$/.test(registryHost);
  if (
    authentication?.kind === "gcloud-docker-helper" &&
    authentication.registryHost !== registryHost
  ) {
    throw new Error(
      `Composition plan registry authentication names host ` +
        `${JSON.stringify(authentication.registryHost)}, but the image repository uses ` +
        `${JSON.stringify(registryHost)}. Rebuild the target plan.`,
    );
  }
  if (shouldConfigureGcloud) {
    commands.push({
      description: `Configure Docker authentication for ${registryHost}`,
      command: "gcloud",
      args: ["auth", "configure-docker", registryHost, "--quiet"],
    });
  }

  if (containerStrategy === "shared-image") {
    const tag = `${registry}/nextjs-app:${buildId}`;
    commands.push({
      description: `Build shared image`,
      command: cli,
      args: ["build", platformArg, "-t", tag, `${outputDir}/shared-context`],
    });
    commands.push({
      description: `Push shared image`,
      command: cli,
      args: ["push", tag],
    });
  } else {
    let poolBaseTag: string | undefined;
    if (poolImageLayout === SHARED_POOL_IMAGE_LAYOUT) {
      const localTag = createHash("sha256")
        .update(`${registry}\0${buildId}`)
        .digest("hex")
        .slice(0, 24);
      poolBaseTag = `localhost/adapter-k8s-pool-base:${localTag}`;
      commands.push({
        description: "Build shared pool base",
        command: cli,
        args: ["build", platformArg, "-t", poolBaseTag, `${outputDir}/pool-base`],
      });
      commands.push({
        description: "Verify shared pool base is visible in the container CLI image store",
        command: cli,
        args: ["image", "inspect", poolBaseTag],
      });
    }
    for (const pool of pools) {
      const tag = `${registry}/nextjs-app-${pool}:${buildId}`;
      commands.push({
        description: `Build ${pool} image`,
        command: cli,
        args: [
          "build",
          platformArg,
          ...(poolBaseTag ? ["--build-arg", `POOL_BASE_IMAGE=${poolBaseTag}`] : []),
          "-t",
          tag,
          `${outputDir}/pools/${pool}`,
        ],
      });
      commands.push({
        description: `Push ${pool} image`,
        command: cli,
        args: ["push", tag],
      });
    }
  }

  if (options.includeRoutingService !== false) {
    const routingTag = `${registry}/routing-service:${buildId}`;
    commands.push({
      description: "Build routing service image",
      command: cli,
      args: [
        "build",
        platformArg,
        "-f",
        `${outputDir}/routing-service/Dockerfile`,
        "-t",
        routingTag,
        `${outputDir}/routing-service`,
      ],
    });
    commands.push({
      description: "Push routing service image",
      command: cli,
      args: ["push", routingTag],
    });
  }

  return commands;
}

// L15: pool names are read from build-metadata.json and used in chart file paths and
// docker build contexts — a malicious or corrupt name (e.g. "../x") could otherwise
// escape the chart templates directory.
export function assertSafePoolName(poolName: string): void {
  // N61: delegate the CHARSET to the shared validator the templates use, so deploy and
  // emit can never disagree. The local copy was `/^[a-z0-9-]+$/`, which admitted a
  // leading/trailing hyphen (an invalid K8s label value) and the YAML-1.1 boolean names
  // (`on`/`no`/`y`/`off`/`true`) the templates now reject.
  try {
    assertSafePoolNameCharset(poolName);
  } catch (err) {
    throw new Error(
      `${err instanceof Error ? err.message : String(err)} (from build-metadata.json — ` +
        `refusing to use it in file paths.)`,
    );
  }
  // "routing-service" is the reserved routing-tier Deployment name (<release>-routing-service,
  // updated in place per build, verified/reverted separately from pools). A pool with this
  // name would collide with it: readiness checks, cleanup classification, and rollback's
  // edge revert all key off that exact name.
  if (poolName === "routing-service") {
    throw new Error(
      `Invalid pool name "routing-service" in build-metadata.json: reserved for the routing ` +
        `tier (<release>-routing-service). Rename the pool (check the adapter's route ` +
        `classification config) and rebuild.`,
    );
  }
}
