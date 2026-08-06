import { open, opendir, stat } from "node:fs/promises";
import path from "node:path";
import { targetArchitecture, type TargetPlatform } from "./target-platform.js";

type NativeFormat = "ELF" | "Mach-O" | "PE" | "unknown native addon";

export interface ForeignNativeArtifact {
  file: string;
  format: NativeFormat;
  architecture?: string;
  compatibility?: string;
}

const NATIVE_SUFFIX_RE = /(?:\.node|\.dylib|\.dll|\.exe|\.so(?:\.[0-9]+)*)$/i;
const PRISMA_ENGINE_RE =
  /(?:^|\/)(?:lib)?(?:query|schema|migration|introspection)[-_]engine(?:[-_.]|$)|(?:^|\/)prisma-fmt(?:[-_.]|$)/i;
const PRISMA_MUSL_ENGINE_RE =
  /(?:^|\/)(?:(?:lib)?(?:query|schema|migration|introspection)[-_]engine|prisma-fmt)[-_.]linux-musl(?:[-_.]|$)/i;

// Sharp is the one native dependency this adapter retargets deliberately: staging selects the
// requested @img pair, and the emitted Dockerfile installs that pair inside the target image
// when the build host did not have it. A shared-image context can still carry the host's unused
// @img optional package; Sharp's runtime loader selects by process.platform/process.arch.
function isManagedSharpArtifact(relativePath: string): boolean {
  return /(?:^|\/)node_modules\/@img\/(?:sharp|sharp-libvips)-[^/]+\//.test(relativePath);
}

function elfArchitecture(header: Buffer): string | undefined {
  if (header.length < 20 || !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    return undefined;
  }
  const littleEndian = header[5] === 1;
  const machine = littleEndian ? header.readUInt16LE(18) : header.readUInt16BE(18);
  if (machine === 0x3e) return "amd64";
  if (machine === 0xb7) return "arm64";
  return `ELF machine 0x${machine.toString(16)}`;
}

function isMachO(header: Buffer): boolean {
  if (header.length < 4) return false;
  const magic = header.readUInt32BE(0);
  return (
    magic === 0xfeedface ||
    magic === 0xcefaedfe ||
    magic === 0xfeedfacf ||
    magic === 0xcffaedfe ||
    magic === 0xcafebabe ||
    magic === 0xbebafeca ||
    magic === 0xcafebabf ||
    magic === 0xbfbafeca
  );
}

function namedNativeCandidate(relativePath: string): boolean {
  return NATIVE_SUFFIX_RE.test(relativePath) || PRISMA_ENGINE_RE.test(relativePath);
}

async function inspectCandidate(
  absolutePath: string,
  relativePath: string,
  targetPlatform: TargetPlatform,
): Promise<ForeignNativeArtifact | null> {
  const handle = await open(absolutePath, "r");
  const header = Buffer.alloc(64);
  try {
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const bytes = header.subarray(0, bytesRead);
    const elf = elfArchitecture(bytes);
    if (elf !== undefined) {
      // The emitted runtime is Debian slim (glibc). Prisma encodes its libc target in engine
      // filenames, which is stronger evidence than the ELF machine alone: an arm64 musl
      // engine is still unusable in an arm64 glibc image. Other native addons do not expose a
      // reliable libc marker, so the broader audit remains architecture-only.
      if (PRISMA_MUSL_ENGINE_RE.test(relativePath)) {
        return {
          file: relativePath,
          format: "ELF",
          architecture: elf,
          compatibility: "Prisma linux-musl engine cannot run in the Debian glibc image",
        };
      }
      return elf === targetArchitecture(targetPlatform)
        ? null
        : { file: relativePath, format: "ELF", architecture: elf };
    }
    if (isMachO(bytes)) return { file: relativePath, format: "Mach-O" };
    if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
      return { file: relativePath, format: "PE" };
    }
    // A .node file is necessarily a native shared library. An unrecognized header is not safe
    // to wave through: it could be another platform/format the detector does not understand.
    if (/\.node$/i.test(relativePath)) {
      return { file: relativePath, format: "unknown native addon" };
    }
    return null;
  } finally {
    await handle.close();
  }
}

export async function findForeignNativeArtifacts(
  contextRoot: string,
  targetPlatform: TargetPlatform,
): Promise<ForeignNativeArtifact[]> {
  const problems: ForeignNativeArtifact[] = [];

  const walk = async (dir: string): Promise<void> => {
    const entries = await opendir(dir);
    for await (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(contextRoot, absolute).split(path.sep).join("/");
      if (isManagedSharpArtifact(relative)) continue;
      // Named native libraries go straight to header inspection. Other files need a mode
      // lookup so extensionless executables are not missed.
      if (!namedNativeCandidate(relative)) {
        const info = await stat(absolute);
        if ((info.mode & 0o111) === 0) continue;
      }
      const problem = await inspectCandidate(absolute, relative, targetPlatform);
      if (problem) problems.push(problem);
    }
  };

  await walk(contextRoot);
  return problems.sort((left, right) => left.file.localeCompare(right.file));
}

export async function assertStagedNativeArtifactsTargetPlatform(
  contextRoots: string[],
  targetPlatform: TargetPlatform,
): Promise<void> {
  const failures: Array<ForeignNativeArtifact & { context: string }> = [];
  for (const context of contextRoots) {
    for (const artifact of await findForeignNativeArtifacts(context, targetPlatform)) {
      failures.push({ ...artifact, context });
    }
  }
  if (failures.length === 0) return;

  const shown = failures.slice(0, 20);
  const details = shown
    .map(
      ({ context, file, format, architecture, compatibility }) =>
        `  - ${path.join(context, file)} (${format}${architecture ? `, ${architecture}` : ""}` +
        `${compatibility ? `, ${compatibility}` : ""})`,
    )
    .join("\n");
  const remaining = failures.length - shown.length;
  throw new Error(
    `[adapter-k8s] Staged runtime artifacts do not match ${targetPlatform}:\n${details}` +
      (remaining > 0 ? `\n  - …and ${remaining} more` : "") +
      `\nThe adapter can retarget Sharp, but it cannot safely rewrite arbitrary native addons ` +
      `or Prisma engines after next build. Build/install dependencies under ${targetPlatform} ` +
      `or configure the dependency to emit that target, then rebuild. Refusing to publish an ` +
      `image that would fail only after scheduling.`,
  );
}
