import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertStagedNativeArtifactsTargetPlatform,
  findForeignNativeArtifacts,
  pruneForeignSharpPackages,
} from "../src/native-artifacts.js";

const roots: string[] = [];

function context(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "adapter-native-artifacts-"));
  roots.push(root);
  return root;
}

function write(root: string, relative: string, bytes: Buffer, mode = 0o644): void {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes, { mode });
}

function elf(machine: 0x3e | 0xb7): Buffer {
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]); // ELF64, little endian, version 1
  header.writeUInt16LE(machine, 18);
  return header;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("staged native artifact target contract", () => {
  it("accepts matching linux native addons for amd64 and arm64", async () => {
    const amd = context();
    const arm = context();
    write(amd, "node_modules/better-sqlite3/build/Release/better_sqlite3.node", elf(0x3e));
    write(arm, "node_modules/bcrypt/lib/binding/napi-v3/bcrypt_lib.node", elf(0xb7));

    await expect(findForeignNativeArtifacts(amd, "linux/amd64")).resolves.toEqual([]);
    await expect(findForeignNativeArtifacts(arm, "linux/arm64")).resolves.toEqual([]);
  });

  it("rejects an x64 native addon staged for an arm64 image", async () => {
    const root = context();
    write(root, "node_modules/canvas/build/Release/canvas.node", elf(0x3e));

    await expect(assertStagedNativeArtifactsTargetPlatform([root], "linux/arm64")).rejects.toThrow(
      /canvas\.node \(ELF, amd64\)/,
    );
  });

  it("rejects a host Prisma engine even when it has no native-library suffix", async () => {
    const root = context();
    write(root, "node_modules/.prisma/client/query-engine-linux-amd64", elf(0x3e), 0o755);

    await expect(assertStagedNativeArtifactsTargetPlatform([root], "linux/arm64")).rejects.toThrow(
      /query-engine-linux-amd64 \(ELF, amd64\)/,
    );
  });

  it("rejects a same-architecture Prisma musl engine for the Debian glibc image", async () => {
    const root = context();
    write(
      root,
      "node_modules/.prisma/client/libquery_engine-linux-musl-openssl-3.0.x.so.node",
      elf(0x3e),
    );

    await expect(assertStagedNativeArtifactsTargetPlatform([root], "linux/amd64")).rejects.toThrow(
      /linux-musl.*cannot run in the Debian glibc image/,
    );
  });

  it("rejects a Prisma formatter built for musl", async () => {
    const root = context();
    write(root, "node_modules/prisma/prisma-fmt-linux-musl", elf(0x3e), 0o755);

    await expect(assertStagedNativeArtifactsTargetPlatform([root], "linux/amd64")).rejects.toThrow(
      /prisma-fmt-linux-musl.*cannot run in the Debian glibc image/,
    );
  });

  it("accepts matching Prisma glibc and Debian engine targets", async () => {
    const arm = context();
    const amd = context();
    write(
      arm,
      "node_modules/.prisma/client/libquery_engine-linux-arm64-openssl-3.0.x.so.node",
      elf(0xb7),
    );
    write(
      amd,
      "node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node",
      elf(0x3e),
    );

    await expect(findForeignNativeArtifacts(arm, "linux/arm64")).resolves.toEqual([]);
    await expect(findForeignNativeArtifacts(amd, "linux/amd64")).resolves.toEqual([]);
  });

  it("rejects Mach-O and PE artifacts for every Linux target", async () => {
    const root = context();
    write(
      root,
      "node_modules/bcrypt/prebuilds/darwin-arm64/bcrypt.node",
      Buffer.from("cffaedfe", "hex"),
    );
    write(root, "node_modules/tool/bin/helper.exe", Buffer.from("4d5a9000", "hex"), 0o755);

    const failures = await findForeignNativeArtifacts(root, "linux/arm64");
    expect(failures).toEqual([
      expect.objectContaining({ format: "Mach-O" }),
      expect.objectContaining({ format: "PE" }),
    ]);
  });

  it("distinguishes a Java class file from a fat Mach-O sharing the CAFEBABE magic", async () => {
    const root = context();
    // Java 17 class file: magic, minor 0, major 61 — the second word (0x0000003d) is far
    // above any real fat-header nfat_arch. Executable bit set, the exact shape that used to
    // abort the build as a foreign "Mach-O".
    write(
      root,
      "node_modules/some-tool/Runner.class",
      Buffer.from("cafebabe0000003d", "hex"),
      0o755,
    );
    // A REAL fat Mach-O (nfat_arch = 2) must still be rejected.
    write(
      root,
      "node_modules/bcrypt/prebuilds/darwin-universal/bcrypt.node",
      Buffer.from("cafebabe00000002", "hex"),
    );

    const failures = await findForeignNativeArtifacts(root, "linux/amd64");
    expect(failures).toEqual([expect.objectContaining({ format: "Mach-O" })]);
    expect(failures[0]!.file).toContain("bcrypt");
  });

  it("fails closed on an unrecognized .node binary", async () => {
    const root = context();
    write(root, "node_modules/addon/build/Release/addon.node", Buffer.from("not a library"));

    await expect(assertStagedNativeArtifactsTargetPlatform([root], "linux/amd64")).rejects.toThrow(
      /unknown native addon/,
    );
  });

  it("leaves host Sharp optional packages to Sharp's explicit target installer", async () => {
    const root = context();
    write(
      root,
      "node_modules/@img/sharp-darwin-arm64/lib/sharp.node",
      Buffer.from("cffaedfe", "hex"),
    );
    write(
      root,
      "node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips.dylib",
      Buffer.from("cffaedfe", "hex"),
    );

    await expect(findForeignNativeArtifacts(root, "linux/amd64")).resolves.toEqual([]);
  });
});

describe("Sharp image-context pruning", () => {
  it("removes host and foreign optional packages while retaining the target pair and colour", async () => {
    const root = context();
    write(root, "node_modules/@img/sharp-darwin-arm64/lib/sharp.node", Buffer.alloc(11));
    write(root, "node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips.dylib", Buffer.alloc(13));
    write(root, "node_modules/@img/sharp-linux-x64/lib/sharp.node", Buffer.alloc(17));
    write(root, "node_modules/@img/sharp-libvips-linux-x64/lib/libvips.so", Buffer.alloc(19));
    write(root, "node_modules/@img/colour/index.js", Buffer.alloc(23));
    write(
      root,
      "node_modules/wrapper/node_modules/@img/sharp-linux-arm64/lib/sharp.node",
      Buffer.alloc(29),
    );

    await expect(pruneForeignSharpPackages(root, "linux/amd64")).resolves.toEqual({
      packages: 3,
      files: 3,
      bytes: 53,
    });
    expect(existsSync(path.join(root, "node_modules/@img/sharp-darwin-arm64"))).toBe(false);
    expect(existsSync(path.join(root, "node_modules/@img/sharp-libvips-darwin-arm64"))).toBe(false);
    expect(
      existsSync(path.join(root, "node_modules/wrapper/node_modules/@img/sharp-linux-arm64")),
    ).toBe(false);
    expect(existsSync(path.join(root, "node_modules/@img/sharp-linux-x64"))).toBe(true);
    expect(existsSync(path.join(root, "node_modules/@img/sharp-libvips-linux-x64"))).toBe(true);
    expect(existsSync(path.join(root, "node_modules/@img/colour"))).toBe(true);
  });

  it("retains the arm64 pair for an arm64 image", async () => {
    const root = context();
    write(root, "node_modules/@img/sharp-linux-arm64/lib/sharp.node", Buffer.alloc(7));
    write(root, "node_modules/@img/sharp-libvips-linux-arm64/lib/libvips.so", Buffer.alloc(9));

    await expect(pruneForeignSharpPackages(root, "linux/arm64")).resolves.toEqual({
      packages: 0,
      files: 0,
      bytes: 0,
    });
  });
});
