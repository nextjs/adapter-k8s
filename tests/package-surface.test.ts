import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(absolute);
    return entry.name.endsWith(".md") ? [absolute] : [];
  });
}

describe("published package consumer surface", () => {
  it("ships every user-facing document referenced by the packaged skills and README", () => {
    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      files: string[];
    };

    expect(packageJson.files).toEqual(
      expect.arrayContaining(["dist", "docker", "docs", "plans", "skills", "SECURITY.md"]),
    );
  });

  it("keeps every relative Markdown link in the published documents resolvable", () => {
    const broken: string[] = [];

    const publishedMarkdown = [
      path.join(repoRoot, "README.md"),
      path.join(repoRoot, "SECURITY.md"),
      ...markdownFiles(path.join(repoRoot, "docs")),
      ...markdownFiles(path.join(repoRoot, "plans")),
      ...markdownFiles(path.join(repoRoot, "skills")),
    ];
    for (const file of publishedMarkdown) {
      const markdown = readFileSync(file, "utf8");
      for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        const target = match[1]?.split("#", 1)[0];
        if (!target || target.startsWith("http://") || target.startsWith("https://")) continue;

        const resolved = path.resolve(path.dirname(file), target);
        if (!existsSync(resolved)) broken.push(`${path.relative(repoRoot, file)} -> ${target}`);
      }
    }

    expect(broken).toEqual([]);
  });

  it("ships Agent Skills with spec-valid discovery frontmatter", () => {
    const skillsRoot = path.join(repoRoot, "skills");
    for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skill = readFileSync(path.join(skillsRoot, entry.name, "SKILL.md"), "utf8");
      const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1];
      expect(frontmatter, `${entry.name}/SKILL.md frontmatter`).toBeDefined();

      const fields = [...frontmatter!.matchAll(/^([a-z][a-z-]*):/gm)].map((match) => match[1]);
      expect(fields, `${entry.name}/SKILL.md fields`).toEqual(["name", "description"]);
      expect(frontmatter).toContain(`name: ${entry.name}\n`);

      const description = /^description: (.+)$/m.exec(frontmatter!)?.[1];
      expect(description?.length, `${entry.name}/SKILL.md description`).toBeGreaterThan(0);
      expect(description!.length, `${entry.name}/SKILL.md description`).toBeLessThanOrEqual(1024);
    }
  });

  it("requires an explicit, checksum-verified kubectl for the cutover image", () => {
    const dockerfile = readFileSync(
      path.join(repoRoot, "docker", "cutover-job.Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toContain("ARG KUBECTL_VERSION\n");
    expect(dockerfile).not.toMatch(/ARG KUBECTL_VERSION=/);
    expect(dockerfile).toContain("kubectl.sha256");
    expect(dockerfile).toContain("sha256sum --check");
  });

  it("documents a target namespace for namespace-less SOPS manifests", () => {
    const gitops = readFileSync(path.join(repoRoot, "docs", "gitops.md"), "utf8");
    expect(gitops).toContain("path: ./kubernetes/apps/<namespace>/<release>/app/bundle/secrets");
    expect(gitops).toContain("targetNamespace: <namespace>");
  });

  it("does not turn every Flux source revision into a Helm upgrade", () => {
    for (const relative of ["docs/gitops.md", "skills/deploy/SKILL.md"]) {
      const content = readFileSync(path.join(repoRoot, relative), "utf8");
      expect(content, relative).not.toContain("reconcileStrategy: Revision");
      expect(content, relative).toContain("ChartVersion");
    }
  });
});
