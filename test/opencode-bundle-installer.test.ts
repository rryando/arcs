import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildArcsBundleInstallPlan,
  detectArcsBundleInstall,
  getSourceArcsBundleInfo,
  installArcsBundle,
  installArcsBundleWithHooks,
  readInstalledArcsBundleManifest,
  type SourceArcsBundleManifest,
  writeInstalledArcsBundleManifest,
} from "../src/cli/bundle-installer.js";
import { withTempHomeDir } from "./helpers/temp-home-dir.js";

const bundleRoot = resolve(import.meta.dirname, "..", "opencode", "arcs");
const sourceManifestPath = resolve(bundleRoot, "manifest.json");
const runtimeManifestPath = resolve(bundleRoot, "bundle-runtime.json");
const packageJsonPath = resolve(import.meta.dirname, "..", "package.json");

type RuntimeManifest = {
  skills: Record<string, string[]>;
  agents: string[];
  plugin: string[];
};

type PackageJson = {
  version: string;
};

function readRuntimeManifest(): RuntimeManifest {
  return JSON.parse(readFileSync(runtimeManifestPath, "utf-8")) as RuntimeManifest;
}

function readSourceManifest(): SourceArcsBundleManifest {
  return JSON.parse(readFileSync(sourceManifestPath, "utf-8")) as SourceArcsBundleManifest;
}

function readExpectedSourceBundleVersion(): string {
  const sourceManifest = readSourceManifest();

  if (sourceManifest.bundleVersionSource !== "package.json") {
    throw new Error(
      `Unsupported bundleVersionSource in test: ${sourceManifest.bundleVersionSource}`,
    );
  }

  return (JSON.parse(readFileSync(packageJsonPath, "utf-8")) as PackageJson).version;
}

// ARCS-native skill files: authored in this repo, not sourced from upstream.
// Must match the skill entries in scripts/build-opencode-bundle.mjs preservedOutputFiles.
const arcsNativeSkillFiles = ["skills/caveman-commit/SKILL.md", "skills/init-project/SKILL.md"];

function curatedBundlePayloadFiles(): string[] {
  const runtimeManifest = readRuntimeManifest();

  return [
    // Repo-authored preserved files included in bundle identity
    "bundle-runtime.json",
    "manifest.json",
    ".opencode/plugins/arcs.js",
    ...Object.entries(runtimeManifest.skills).flatMap(([skillName, files]) =>
      files.map((relativePath) => `skills/${skillName}/${relativePath}`),
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
    // Orchestrator prompt files generated from src/cli/arcs-orchestrate*.ts by
    // build-opencode-bundle.mjs and committed to the repo bundle.
    "prompts/arcs-orchestrate.txt",
    "prompts/arcs-orchestrate-caveman.txt",
  ].sort((a, b) => a.localeCompare(b));
}

function computeBundleHash(relativePaths: string[]): string {
  const hash = createHash("sha256");

  for (const relativePath of relativePaths) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(readFileSync(resolve(bundleRoot, relativePath)));
    hash.update("\0");
  }

  return hash.digest("hex");
}

function expectRuntimePayloadInstalled(homeDir: string): void {
  const runtimeManifest = readRuntimeManifest();

  for (const [skillName, files] of Object.entries(runtimeManifest.skills)) {
    for (const relativePath of files) {
      expect(
        existsSync(
          resolve(homeDir, ".config", "opencode", "skills", "arcs", skillName, relativePath),
        ),
      ).toBe(true);
    }
  }

  for (const pluginPath of runtimeManifest.plugin) {
    expect(
      existsSync(resolve(homeDir, ".config", "opencode", pluginPath.replace(/^\.opencode\//, ""))),
    ).toBe(true);
  }

  for (const agentPath of runtimeManifest.agents) {
    expect(
      existsSync(resolve(homeDir, ".config", "opencode", agentPath.replace(/^agents\//, "agent/"))),
    ).toBe(true);
  }
}

const expectedSourceBundleVersion = readExpectedSourceBundleVersion();

const sourceManifestWithConfigOnly: SourceArcsBundleManifest = {
  bundleId: "arcs-opencode-bundle",
  installMode: "opencode-arcs",
  bundleVersionSource: "package.json",
  sourceRoot: "opencode/arcs",
  skills: { source: "skills", destination: "skills/arcs" },
  agents: [],
  ownedPaths: ["skills/arcs", "plugins/arcs.js"],
  plugin: {
    required: true,
    source: ".opencode/plugins/arcs.js",
    destination: "plugins/arcs.js",
  },
  config: {
    requiredMerges: [{ path: ["plugin", "arcs"], value: { type: "local" } }],
  },
};

const sourceManifestWithoutConfigRequirement: SourceArcsBundleManifest = {
  ...sourceManifestWithConfigOnly,
  config: { requiredMerges: [] },
};

const ownedManifest = {
  bundleId: "arcs-opencode-bundle",
  installMode: "opencode-arcs",
  sourceBundleVersion: expectedSourceBundleVersion,
  sourceBundleHash: "abc",
  installedAt: "2026-03-18T00:00:00.000Z",
  ownedPaths: ["skills/arcs", "plugins/arcs.js"],
};

describe("opencode ARCS bundle install detection", () => {
  it("returns absent when nothing is installed", async () => {
    await withTempHomeDir(async () => {
      expect(detectArcsBundleInstall().state).toBe("absent");
    });
  });

  it("returns foreign-existing when destination paths exist without ARCS manifest", async () => {
    await withTempHomeDir(async (homeDir) => {
      mkdirSync(resolve(homeDir, ".config", "opencode", "skills", "arcs"), {
        recursive: true,
      });

      expect(detectArcsBundleInstall().state).toBe("foreign-existing");
    });
  });

  it("returns foreign-existing when only required config merge keys exist", async () => {
    await withTempHomeDir(async (homeDir) => {
      writeFileSync(
        resolve(homeDir, ".config", "opencode", "opencode.json"),
        JSON.stringify({ plugin: { arcs: { type: "local" } } }, null, 2),
        "utf-8",
      );

      expect(detectArcsBundleInstall(sourceManifestWithConfigOnly).state).toBe("foreign-existing");
    });
  });

  it("returns foreign-existing when a ARCS manifest exists but owned paths are missing", async () => {
    await withTempHomeDir(async () => {
      writeInstalledArcsBundleManifest(ownedManifest);
      expect(detectArcsBundleInstall().state).toBe("foreign-existing");
    });
  });

  it("reports arcs-managed when the installed manifest exists and all declared owned paths exist", async () => {
    await withTempHomeDir(async (homeDir) => {
      mkdirSync(resolve(homeDir, ".config", "opencode", "skills", "arcs"), {
        recursive: true,
      });
      mkdirSync(resolve(homeDir, ".config", "opencode", "plugins"), { recursive: true });
      writeFileSync(
        resolve(homeDir, ".config", "opencode", "plugins", "arcs.js"),
        "plugin",
        "utf-8",
      );
      writeInstalledArcsBundleManifest(ownedManifest);

      expect(readInstalledArcsBundleManifest()).toMatchObject(ownedManifest);
      expect(detectArcsBundleInstall(sourceManifestWithoutConfigRequirement).state).toBe(
        "arcs-managed",
      );
    });
  });
});

describe("opencode ARCS bundle bundle identity", () => {
  it("ships bundle-runtime.json alongside the installer manifest", () => {
    expect(existsSync(sourceManifestPath)).toBe(true);
    expect(existsSync(runtimeManifestPath)).toBe(true);
  });

  it("computes deterministic source bundle metadata", () => {
    const info = getSourceArcsBundleInfo();
    const curatedPayloadFiles = curatedBundlePayloadFiles();

    expect(info.bundleId).toBe("arcs-opencode-bundle");
    expect(info.sourceBundleVersion).toBe(expectedSourceBundleVersion);
    expect(info.sourceBundleHash).toMatch(/^[a-f0-9]{64}$/);
    expect(curatedPayloadFiles).toContain("bundle-runtime.json");
    expect(curatedPayloadFiles).toContain("manifest.json");
    for (const relativePath of curatedPayloadFiles) {
      expect(existsSync(resolve(bundleRoot, relativePath))).toBe(true);
    }
    expect(info.sourceBundleHash).toBe(computeBundleHash(curatedPayloadFiles));
  });

  it("plans removal for previously owned paths missing from the new source manifest", async () => {
    await withTempHomeDir(async () => {
      writeInstalledArcsBundleManifest({
        ...ownedManifest,
        sourceBundleHash: "old-hash",
        ownedPaths: ["skills/arcs", "plugins/old-superpowers.js"],
      });

      const plan = buildArcsBundleInstallPlan();

      expect(plan.pathsToRemove).toContain("plugins/old-superpowers.js");
      expect(plan.pathsToWrite).toContain("skills/arcs");
      expect(plan.pathsToWrite).toContain("plugins/arcs.js");
      expect(plan.pathsToWrite).not.toContain("agent/code-reviewer.md");
    });
  });
});

describe("opencode ARCS bundle installer", () => {
  it("refuses to replace a foreign install without auto-confirm", async () => {
    await withTempHomeDir(async (homeDir) => {
      mkdirSync(resolve(homeDir, ".config", "opencode", "plugins"), { recursive: true });
      writeFileSync(
        resolve(homeDir, ".config", "opencode", "plugins", "arcs.js"),
        "foreign plugin",
        "utf-8",
      );

      expect(() => installArcsBundle()).toThrow(/manual confirmation is required/i);
    });
  });

  it("replaces a foreign install when auto-confirmed and installs the curated runtime payload", async () => {
    await withTempHomeDir(async (homeDir) => {
      const foreignPluginPath = resolve(homeDir, ".config", "opencode", "plugins", "arcs.js");
      mkdirSync(resolve(homeDir, ".config", "opencode", "plugins"), { recursive: true });
      writeFileSync(foreignPluginPath, "foreign plugin", "utf-8");

      const result = installArcsBundle({ autoConfirmReplacement: true });

      expect(result.status).toBe("installed");
      expectRuntimePayloadInstalled(homeDir);
      expect(readFileSync(foreignPluginPath, "utf-8")).not.toBe("foreign plugin");
      expect(readInstalledArcsBundleManifest()?.sourceBundleVersion).toBe(
        expectedSourceBundleVersion,
      );
    });
  });

  it("installs bundled runtime payload and writes the bundled model presets into opencode.json", async () => {
    await withTempHomeDir(async (homeDir) => {
      const result = installArcsBundle({ autoConfirmReplacement: true });
      const opencodeConfig = JSON.parse(
        readFileSync(resolve(homeDir, ".config", "opencode", "opencode.json"), "utf-8"),
      );

      expect(result.status).toBe("installed");
      expectRuntimePayloadInstalled(homeDir);

      expect(opencodeConfig).toMatchObject({
        model: "github-copilot/claude-sonnet-4.6",
        agent: {
          build: {
            model: "github-copilot/claude-sonnet-4.6",
          },
          plan: {
            model: "github-copilot/claude-opus-4.6",
          },
          general: {
            model: "github-copilot/claude-opus-4.6",
          },
          "graph-explorer": {
            mode: "subagent",
            model: "github-copilot/claude-haiku-4.5",
          },
          "code-reviewer": {
            mode: "subagent",
            model: "github-copilot/claude-haiku-4.5",
          },
          "docs-researcher": {
            mode: "subagent",
            model: "github-copilot/claude-opus-4.6",
          },
          "tech-architect": {
            mode: "subagent",
            model: "github-copilot/claude-haiku-4.5",
          },
        },
      });
      expect(opencodeConfig).not.toHaveProperty("plugin");
      expect(readInstalledArcsBundleManifest()?.ownedPaths).toContain("skills/arcs");
    });
  });

  it("preserves user-set model and small_model values across re-install (if-absent merges)", async () => {
    await withTempHomeDir(async (homeDir) => {
      const configPath = resolve(homeDir, ".config", "opencode", "opencode.json");
      // Simulate a user who already configured their own provider/model routing.
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            model: "tvlk-provider/claude-sonnet-4.6",
            small_model: "tvlk-provider/claude-haiku-4.5",
            agent: {
              build: { model: "tvlk-provider/claude-sonnet-4.6" },
              plan: { model: "tvlk-provider/claude-opus-4.7" },
              general: { model: "tvlk-provider/claude-opus-4.7" },
              explore: { model: "tvlk-provider/claude-haiku-4.5" },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      installArcsBundle({ autoConfirmReplacement: true });
      const opencodeConfig = JSON.parse(readFileSync(configPath, "utf-8"));

      // User's provider routing must survive deploy.
      expect(opencodeConfig.model).toBe("tvlk-provider/claude-sonnet-4.6");
      expect(opencodeConfig.small_model).toBe("tvlk-provider/claude-haiku-4.5");
      expect(opencodeConfig.agent.build.model).toBe("tvlk-provider/claude-sonnet-4.6");
      expect(opencodeConfig.agent.plan.model).toBe("tvlk-provider/claude-opus-4.7");
      expect(opencodeConfig.agent.general.model).toBe("tvlk-provider/claude-opus-4.7");
      expect(opencodeConfig.agent.explore.model).toBe("tvlk-provider/claude-haiku-4.5");
    });
  });

  it("seeds default model and small_model on a fresh install (no prior config)", async () => {
    await withTempHomeDir(async (homeDir) => {
      installArcsBundle({ autoConfirmReplacement: true });
      const opencodeConfig = JSON.parse(
        readFileSync(resolve(homeDir, ".config", "opencode", "opencode.json"), "utf-8"),
      );

      // Defaults still seed when the user hasn't picked yet.
      expect(opencodeConfig.model).toBe("github-copilot/claude-sonnet-4.6");
      expect(opencodeConfig.small_model).toBe("github-copilot/claude-haiku-4.5");
    });
  });

  it("enables LSP by default on a fresh install", async () => {
    await withTempHomeDir(async (homeDir) => {
      installArcsBundle({ autoConfirmReplacement: true });
      const opencodeConfig = JSON.parse(
        readFileSync(resolve(homeDir, ".config", "opencode", "opencode.json"), "utf-8"),
      );

      expect(opencodeConfig.lsp).toBe(true);
    });
  });

  it("preserves a user-set lsp value across re-install (e.g. disabled or custom servers)", async () => {
    await withTempHomeDir(async (homeDir) => {
      const configPath = resolve(homeDir, ".config", "opencode", "opencode.json");
      // User opted out of LSP, or set a custom per-server config.
      writeFileSync(configPath, JSON.stringify({ lsp: false }, null, 2), "utf-8");

      installArcsBundle({ autoConfirmReplacement: true });
      const opencodeConfig = JSON.parse(readFileSync(configPath, "utf-8"));

      expect(opencodeConfig.lsp).toBe(false);
    });
  });

  it("removes previously owned paths that are no longer in the source manifest", async () => {
    await withTempHomeDir(async (homeDir) => {
      const stalePath = resolve(homeDir, ".config", "opencode", "plugins", "old-superpowers.js");
      mkdirSync(resolve(homeDir, ".config", "opencode", "plugins"), { recursive: true });
      writeFileSync(stalePath, "stale", "utf-8");
      writeInstalledArcsBundleManifest({
        ...ownedManifest,
        ownedPaths: ["skills/arcs", "plugins/old-superpowers.js"],
      });

      installArcsBundle({ autoConfirmReplacement: true });
      expect(existsSync(stalePath)).toBe(false);
    });
  });

  it("restores the prior installed manifest and opencode state when a mid-install failure occurs", async () => {
    await withTempHomeDir(async (homeDir) => {
      const foreignPlugin = resolve(homeDir, ".config", "opencode", "plugins", "arcs.js");
      const configPath = resolve(homeDir, ".config", "opencode", "opencode.json");
      const priorManifest = {
        ...ownedManifest,
        sourceBundleHash: "previous-hash",
      };

      mkdirSync(resolve(homeDir, ".config", "opencode", "plugins"), { recursive: true });
      writeFileSync(foreignPlugin, "foreign plugin", "utf-8");
      writeFileSync(configPath, JSON.stringify({ existing: true }, null, 2), "utf-8");
      writeInstalledArcsBundleManifest(priorManifest);

      expect(() =>
        installArcsBundleWithHooks({
          autoConfirmReplacement: true,
          hooks: {
            afterConfigPreparedBeforeManifestWrite: () => {
              throw new Error("boom");
            },
          },
        }),
      ).toThrow("boom");

      expect(readFileSync(foreignPlugin, "utf-8")).toBe("foreign plugin");
      expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({ existing: true });
      expect(readInstalledArcsBundleManifest()).toMatchObject(priorManifest);
    });
  });
});
