import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHomeDir } from "./helpers/temp-home-dir.js";

const root = resolve(import.meta.dirname, "..");
const bundleRoot = resolve(root, "opencode/arcs");
const manifestPath = resolve(bundleRoot, "manifest.json");
const runtimeManifestPath = resolve(bundleRoot, "bundle-runtime.json");
const skillsDir = resolve(bundleRoot, "skills");

type InstallerManifest = {
  bundleId: string;
  installMode: string;
  sourceRoot: string;
  skills: {
    source: string;
    destination: string;
  };
  plugin: {
    required: boolean;
    source: string;
  };
  agents: Array<{
    source: string;
    destination: string;
  }>;
  config: {
    requiredMerges: Array<{
      path: string[];
      value: unknown;
    }>;
  };
};

type RuntimeManifest = {
  skills: Record<string, string[]>;
  agents: string[];
  plugin: string[];
  excludePatterns: string[];
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

    return [
      dirname(entryPath) === rootPath
        ? entry.name
        : `${entryPath.slice(rootPath.length + 1).replace(/\\/g, "/")}`,
    ];
  });
}

function runBundleBuild(outputRoot: string) {
  return spawnSync("node", [resolve(root, "scripts/build-opencode-bundle.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      ARCS_BUNDLE_OUTPUT_ROOT: outputRoot,
    },
    encoding: "utf-8",
  });
}

describe("opencode ARCS bundle bundle", () => {
  it("ships a manifest with required install metadata", () => {
    const manifest = readJsonFile<InstallerManifest>(manifestPath);

    expect(manifest.bundleId).toBe("arcs-opencode-bundle");
    expect(manifest.installMode).toBe("opencode-arcs");
    expect(manifest.sourceRoot).toBe("opencode/arcs");
    expect(manifest.skills.source).toBe("skills");
    expect(manifest.skills.destination).toBe("skills/arcs");
    expect(manifest.plugin.required).toBe(true);
    expect(manifest.plugin.source).toBe(".opencode/plugins/arcs.js");
    expect(manifest.agents).toEqual([
      { source: "prompts/software-engineer.txt", destination: "prompts/software-engineer.txt" },
      { source: "prompts/tech-architect.txt", destination: "prompts/tech-architect.txt" },
      { source: "prompts/qa-analyst.txt", destination: "prompts/qa-analyst.txt" },
      { source: "prompts/oncall-ops.txt", destination: "prompts/oncall-ops.txt" },
      { source: "prompts/arcs-docs.txt", destination: "prompts/arcs-docs.txt" },
      { source: "prompts/system-architect.txt", destination: "prompts/system-architect.txt" },
      { source: "prompts/code-reviewer.txt", destination: "prompts/code-reviewer.txt" },
      { source: "prompts/docs-researcher.txt", destination: "prompts/docs-researcher.txt" },
      { source: "prompts/devil-advocate.txt", destination: "prompts/devil-advocate.txt" },
      { source: "prompts/graph-explorer.txt", destination: "prompts/graph-explorer.txt" },
      { source: "prompts/arcs-orchestrate.txt", destination: "prompts/arcs-orchestrate.txt" },
      {
        source: "prompts/arcs-orchestrate-caveman.txt",
        destination: "prompts/arcs-orchestrate-caveman.txt",
      },
    ]);
    expect(manifest.config.requiredMerges).toEqual(
      expect.arrayContaining([
        {
          path: ["model"],
          value: "github-copilot/claude-sonnet-4.6",
          mode: "if-absent",
        },
        {
          path: ["agent", "build", "model"],
          value: "github-copilot/claude-sonnet-4.6",
          mode: "if-absent",
        },
        {
          path: ["agent", "plan", "model"],
          value: "github-copilot/claude-opus-4.6",
          mode: "if-absent",
        },
        {
          path: ["agent", "general", "model"],
          value: "github-copilot/claude-opus-4.6",
          mode: "if-absent",
        },
        {
          path: ["agent", "graph-explorer"],
          value: expect.objectContaining({
            mode: "subagent",
            model: "github-copilot/claude-haiku-4.5",
          }),
          mode: "merge",
        },
        {
          path: ["agent", "code-reviewer"],
          value: expect.objectContaining({
            mode: "subagent",
            model: "github-copilot/claude-haiku-4.5",
          }),
          mode: "merge",
        },
        {
          path: ["agent", "docs-researcher"],
          value: expect.objectContaining({
            mode: "subagent",
            model: "github-copilot/claude-opus-4.6",
          }),
          mode: "merge",
        },
        {
          path: ["agent", "tech-architect"],
          value: expect.objectContaining({
            mode: "subagent",
            model: "github-copilot/claude-haiku-4.5",
          }),
          mode: "merge",
        },
      ]),
    );
  });

  it("ships bundle-runtime.json alongside manifest.json", () => {
    const runtimeManifest = readJsonFile<RuntimeManifest>(runtimeManifestPath);

    expect(existsSync(manifestPath)).toBe(true);
    expect(existsSync(runtimeManifestPath)).toBe(true);
    expect(dirname(runtimeManifestPath)).toBe(dirname(manifestPath));
    expect(Object.keys(runtimeManifest).sort()).toEqual([
      "agents",
      "excludePatterns",
      "plugin",
      "skills",
    ]);
    expect(runtimeManifest.excludePatterns).toEqual([
      "**/references/**",
      "**/examples/**",
      "**/CREATION-LOG.md",
      "**/test-pressure-*.md",
    ]);
  });

  it("includes the exact runtime-manifest bundle payload", () => {
    const runtimeManifest = readJsonFile<RuntimeManifest>(runtimeManifestPath);
    const outputRoot = mkdtempSync(resolve(tmpdir(), "opencode-bundle-smoke-"));

    // ARCS-native skills (authored in this repo) live in the bundle but aren't
    // declared in bundle-runtime.json — they are preserved output files.
    const arcsNativeSkillNames = ["caveman-commit", "init-project", "the-ladder"];
    const expectedSkillNames = [
      ...new Set([...Object.keys(runtimeManifest.skills), ...arcsNativeSkillNames]),
    ].sort();
    expect(readdirSync(skillsDir).sort()).toEqual(expectedSkillNames);

    try {
      // Output root IS the source of truth — copy the real bundle into the
      // temp output root, then exercise the build to confirm it validates
      // declared files, preserves preservedOutputFiles, and prunes nothing
      // that should survive.
      cpSync(bundleRoot, outputRoot, { recursive: true });

      const result = runBundleBuild(outputRoot);

      expect(result.status).toBe(0);
      // Skills dir contains the manifest-declared skills plus the ARCS-native
      // skills (preservedOutputFiles) — the build prunes nothing in this set.
      const arcsNativeSkillNames = ["caveman-commit", "init-project", "the-ladder"];
      const expectedSkillsAfterBuild = [
        ...new Set([...Object.keys(runtimeManifest.skills), ...arcsNativeSkillNames]),
      ].sort();
      expect(
        readdirSync(resolve(outputRoot, "skills"), { withFileTypes: true })
          .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ).toEqual(
        expectedSkillsAfterBuild.map((skillName) => ({ name: skillName, isDirectory: true })),
      );

      for (const [skillName, files] of Object.entries(runtimeManifest.skills)) {
        const bundledSkillDir = resolve(outputRoot, "skills", skillName);

        expect(listRelativeFiles(bundledSkillDir).sort()).toEqual([...files].sort());

        for (const relativeFilePath of files) {
          expect(existsSync(resolve(bundledSkillDir, relativeFilePath))).toBe(true);
        }
      }

      if (runtimeManifest.agents.length > 0) {
        expect(listRelativeFiles(resolve(outputRoot, "agents")).sort()).toEqual(
          runtimeManifest.agents.map((agentPath) => agentPath.replace(/^agents\//, "")).sort(),
        );
      }

      for (const agentPath of runtimeManifest.agents) {
        expect(existsSync(resolve(outputRoot, agentPath))).toBe(true);
      }

      const pluginsDir = resolve(outputRoot, ".opencode", "plugins");
      const actualPluginFiles = existsSync(pluginsDir) ? listRelativeFiles(pluginsDir).sort() : [];
      // plugins/ contains arcs.js as a preservedOutputFiles entry plus any
      // additional plugins declared in runtimeManifest.plugin.
      const expectedPluginFiles = [
        ...new Set([
          "arcs.js",
          ...runtimeManifest.plugin.map((p) => p.replace(/^\.opencode\/plugins\//, "")),
        ]),
      ].sort();
      expect(actualPluginFiles).toEqual(expectedPluginFiles);

      for (const pluginPath of runtimeManifest.plugin) {
        expect(existsSync(resolve(outputRoot, pluginPath))).toBe(true);
      }
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it("keeps the opencode bundle in package publish files", () => {
    const pkg = readJsonFile<{ files: string[] }>(resolve(root, "package.json"));

    expect(pkg.files).toContain("opencode/");
    expect(pkg.files).toContain("skills/");
  });

  it("creates an isolated OpenCode config home for installer tests", async () => {
    await withTempHomeDir(async (homeDir) => {
      expect(existsSync(resolve(homeDir, ".config", "opencode"))).toBe(true);
    });
  });
});
