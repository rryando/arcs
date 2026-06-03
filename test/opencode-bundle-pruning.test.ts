import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const bundleRoot = resolve(root, "opencode/arcs");
const runtimeManifestPath = resolve(bundleRoot, "bundle-runtime.json");

type RuntimeManifest = {
  skills: Record<string, string[]>;
  agents: string[];
  plugin: string[];
};

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf-8")) as T;
}

function listRelativeFiles(rootPath: string, currentPath = rootPath): string[] {
  const entries = readdirSync(currentPath, { withFileTypes: true });

  return entries.flatMap((entry) => {
    const entryPath = resolve(currentPath, entry.name);

    if (entry.isDirectory()) {
      return listRelativeFiles(rootPath, entryPath);
    }

    return [entryPath.slice(rootPath.length + 1).replace(/\\/g, "/")];
  });
}

// ARCS-native skills: authored in this repo, not sourced from upstream.
// Must match the skill entries in scripts/build-opencode-bundle.mjs preservedOutputFiles.
const arcsNativeSkillFiles = ["skills/caveman-commit/SKILL.md", "skills/init-project/SKILL.md"];

describe("checked-in opencode bundle pruning", () => {
  it("matches the runtime manifest exactly", () => {
    const runtimeManifest = readJsonFile<RuntimeManifest>(runtimeManifestPath);
    const expectedBundleFiles = [
      // Repo-authored preserved files (not sourced from installed location)
      "bundle-runtime.json",
      "manifest.json",
      ".opencode/plugins/arcs.js",
      ...Object.entries(runtimeManifest.skills).flatMap(([skillName, skillFiles]) =>
        skillFiles.map((relativeFilePath) => `skills/${skillName}/${relativeFilePath}`),
      ),
      ...runtimeManifest.agents,
      ...runtimeManifest.plugin,
      // ARCS-native skills live in the bundle but aren't declared in bundle-runtime.json
      ...arcsNativeSkillFiles,
      // Agent prompt files (repo-authored, referenced via {file:} in manifest.json)
      "prompts/code-reviewer.txt",
      "prompts/devil-advocate.txt",
      "prompts/docs-researcher.txt",
      "prompts/graph-explorer.txt",
      "prompts/oncall-ops.txt",
      "prompts/qa-analyst.txt",
      "prompts/software-engineer.txt",
      "prompts/arcs-docs.txt",
      "prompts/system-architect.txt",
      "prompts/tech-architect.txt",
      // Orchestrator prompt files generated from src/cli/arcs-orchestrate*.ts
      // by build-opencode-bundle.mjs and committed to the repo bundle.
      "prompts/arcs-orchestrate.txt",
      "prompts/arcs-orchestrate-caveman.txt",
    ].sort();

    expect(listRelativeFiles(bundleRoot).sort()).toEqual(expectedBundleFiles);

    for (const [skillName, skillFiles] of Object.entries(runtimeManifest.skills)) {
      for (const relativeFilePath of skillFiles) {
        const bundledPath = resolve(bundleRoot, "skills", skillName, relativeFilePath);

        expect(
          existsSync(bundledPath),
          `missing runtime skill file: skills/${skillName}/${relativeFilePath}`,
        ).toBe(true);
      }
    }

    for (const relativePath of runtimeManifest.agents) {
      expect(
        existsSync(resolve(bundleRoot, relativePath)),
        `missing runtime agent file: ${relativePath}`,
      ).toBe(true);
    }

    for (const relativePath of runtimeManifest.plugin) {
      expect(
        existsSync(resolve(bundleRoot, relativePath)),
        `missing runtime plugin file: ${relativePath}`,
      ).toBe(true);
    }
  });

  it("keeps representative known-pruned files out of the checked-in bundle", () => {
    const knownPrunedPaths = [
      "skills/systematic-debugging/CREATION-LOG.md",
      "skills/systematic-debugging/test-pressure-1.md",
      "skills/using-superpowers/references/codex-tools.md",
      "skills/writing-skills/examples/CLAUDE_MD_TESTING.md",
    ];

    for (const relativePath of knownPrunedPaths) {
      expect(
        existsSync(resolve(bundleRoot, relativePath)),
        `expected known-pruned bundle file to be absent: ${relativePath}`,
      ).toBe(false);
    }
  });

  it("does not point runtime docs at intentionally pruned companion files", () => {
    const forbiddenSnippets = [
      "references/codex-tools.md",
      "references/gemini-tools.md",
      "examples/CLAUDE_MD_TESTING.md",
      "persuasion-principles.md",
      "CREATION-LOG.md",
      "test-pressure-1.md",
      "test-pressure-2.md",
      "test-pressure-3.md",
      "test-academic.md",
    ];
    const bundledMarkdownDocs = listRelativeFiles(bundleRoot)
      .filter((relativePath) => relativePath.endsWith(".md"))
      .sort();

    for (const relativePath of bundledMarkdownDocs) {
      const bundledContent = readFileSync(resolve(bundleRoot, relativePath), "utf-8");

      for (const forbiddenSnippet of forbiddenSnippets) {
        expect(
          bundledContent,
          `${relativePath} should not reference pruned file ${forbiddenSnippet}`,
        ).not.toContain(forbiddenSnippet);
      }
    }
  });
});
