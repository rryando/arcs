import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const deployScript = resolve(root, "scripts/deploy-opencode-bundle.mjs");

type DeployResult = {
  dryRun: boolean;
  source: string;
  destination: string;
  filesAdded: string[];
  filesChanged: string[];
  filesRemoved: string[];
  filesUnchanged: string[];
  restartRequired: boolean;
  restartGuidance?: string;
  codegraphWired: boolean;
  rtkWired: boolean;
};

function writeFile(rootPath: string, relativePath: string, content: string) {
  const outputPath = resolve(rootPath, relativePath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content);
}

function runDeploy(env: Record<string, string>) {
  return spawnSync("node", [deployScript], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf-8",
  });
}

function setupBundleRoot(tempRoot: string) {
  const bundleRoot = resolve(tempRoot, "bundle");
  // Minimal manifest.json
  const manifest = {
    bundleId: "arcs-opencode-bundle",
    installMode: "opencode-arcs",
    sourceRoot: "opencode/arcs",
    skills: { source: "skills", destination: "skills/arcs" },
    agents: [],
    // ownedPaths matches manifest schema: directories/files the deployer owns for removal tests
    ownedPaths: ["skills/arcs", "plugins/arcs.js"],
    plugin: {
      required: true,
      source: ".opencode/plugins/arcs.js",
      destination: "plugins/arcs.js",
    },
    config: { requiredMerges: [] },
  };
  writeFile(bundleRoot, "manifest.json", JSON.stringify(manifest, null, 2));
  writeFile(bundleRoot, "skills/planner/SKILL.md", "# Planner skill");
  writeFile(bundleRoot, "skills/planner/notes.md", "notes content");
  writeFile(bundleRoot, ".opencode/plugins/arcs.js", "// plugin code");
  return bundleRoot;
}

describe("deploy-opencode-bundle", () => {
  it("defaults to dry-run and reports files to add", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "deploy-dry-"));
    const configRoot = resolve(tempRoot, "config");

    try {
      const bundleRoot = setupBundleRoot(tempRoot);

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
      });

      expect(proc.status).toBe(0);
      const result = JSON.parse(proc.stdout) as DeployResult;
      expect(result.dryRun).toBe(true);
      expect(result.filesAdded).toContain("skills/arcs/planner/SKILL.md");
      expect(result.filesAdded).toContain("skills/arcs/planner/notes.md");
      expect(result.filesAdded).toContain("plugins/arcs.js");
      // Dry-run: files should NOT actually be written, no external wiring
      expect(existsSync(resolve(configRoot, "skills/arcs/planner/SKILL.md"))).toBe(false);
      expect(result.codegraphWired).toBe(false);
      expect(result.rtkWired).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("copies files when dryRun=false", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "deploy-write-"));
    const configRoot = resolve(tempRoot, "config");

    try {
      const bundleRoot = setupBundleRoot(tempRoot);

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
        DEPLOY_DRY_RUN: "false",
      });

      expect(proc.status).toBe(0);
      const result = JSON.parse(proc.stdout) as DeployResult;
      expect(result.dryRun).toBe(false);
      expect(result.filesAdded.length).toBeGreaterThan(0);
      // Real-write deploys still skip external wiring under the test suite:
      // global-setup exports ARCS_SKIP_CODEGRAPH/ARCS_SKIP_RTK and the child
      // process inherits them, so the developer's host config is never touched.
      expect(result.codegraphWired).toBe(false);
      expect(result.rtkWired).toBe(false);
      // Files actually written
      expect(readFileSync(resolve(configRoot, "skills/arcs/planner/SKILL.md"), "utf-8")).toBe(
        "# Planner skill",
      );
      expect(readFileSync(resolve(configRoot, "plugins/arcs.js"), "utf-8")).toBe("// plugin code");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("detects changed files when config already exists", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "deploy-change-"));
    const configRoot = resolve(tempRoot, "config");

    try {
      const bundleRoot = setupBundleRoot(tempRoot);
      // Pre-populate config with old content
      writeFile(configRoot, "skills/arcs/planner/SKILL.md", "old content");
      writeFile(configRoot, "skills/arcs/planner/notes.md", "notes content"); // same

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
      });

      expect(proc.status).toBe(0);
      const result = JSON.parse(proc.stdout) as DeployResult;
      expect(result.filesChanged).toContain("skills/arcs/planner/SKILL.md");
      expect(result.filesUnchanged).toContain("skills/arcs/planner/notes.md");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("detects files to remove from owned paths", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "deploy-remove-"));
    const configRoot = resolve(tempRoot, "config");

    try {
      const bundleRoot = setupBundleRoot(tempRoot);
      // Config has a file no longer in bundle
      writeFile(configRoot, "skills/arcs/obsolete/SKILL.md", "old skill");

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
      });

      expect(proc.status).toBe(0);
      const result = JSON.parse(proc.stdout) as DeployResult;
      expect(result.filesRemoved).toContain("skills/arcs/obsolete/SKILL.md");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("removes files when dryRun=false", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "deploy-rm-"));
    const configRoot = resolve(tempRoot, "config");

    try {
      const bundleRoot = setupBundleRoot(tempRoot);
      writeFile(configRoot, "skills/arcs/obsolete/SKILL.md", "old skill");

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
        DEPLOY_DRY_RUN: "false",
      });

      expect(proc.status).toBe(0);
      const result = JSON.parse(proc.stdout) as DeployResult;
      expect(result.filesRemoved).toContain("skills/arcs/obsolete/SKILL.md");
      expect(existsSync(resolve(configRoot, "skills/arcs/obsolete/SKILL.md"))).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports restartRequired when plugin absent (first-time deploy)", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "deploy-restart-new-"));
    const configRoot = resolve(tempRoot, "config");

    try {
      const bundleRoot = setupBundleRoot(tempRoot);
      // No plugin in config — first-time deploy

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
      });

      expect(proc.status).toBe(0);
      const result = JSON.parse(proc.stdout) as DeployResult;
      expect(result.restartRequired).toBe(true);
      expect(result.filesAdded).toContain("plugins/arcs.js");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("deploys agent prompts declared in manifest.agents", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "deploy-agents-"));
    const configRoot = resolve(tempRoot, "config");

    try {
      const bundleRoot = resolve(tempRoot, "bundle");
      const manifest = {
        bundleId: "arcs-opencode-bundle",
        installMode: "opencode-arcs",
        sourceRoot: "opencode/arcs",
        skills: { source: "skills", destination: "skills/arcs" },
        agents: [
          {
            source: "prompts/test-agent.txt",
            destination: "prompts/test-agent.txt",
          },
        ],
        ownedPaths: ["skills/arcs", "plugins/arcs.js"],
        plugin: {
          required: true,
          source: ".opencode/plugins/arcs.js",
          destination: "plugins/arcs.js",
        },
        config: { requiredMerges: [] },
      };
      writeFile(bundleRoot, "manifest.json", JSON.stringify(manifest, null, 2));
      writeFile(bundleRoot, "skills/planner/SKILL.md", "# Planner skill");
      writeFile(bundleRoot, ".opencode/plugins/arcs.js", "// plugin code");
      writeFile(bundleRoot, "prompts/test-agent.txt", "agent prompt body");

      // First deploy: agent file should be added
      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
        DEPLOY_DRY_RUN: "false",
      });

      expect(proc.status).toBe(0);
      const result = JSON.parse(proc.stdout) as DeployResult;
      expect(result.filesAdded).toContain("prompts/test-agent.txt");
      expect(readFileSync(resolve(configRoot, "prompts/test-agent.txt"), "utf-8")).toBe(
        "agent prompt body",
      );

      // Second deploy with changed source: agent file should be reported changed
      writeFile(bundleRoot, "prompts/test-agent.txt", "agent prompt body v2");
      const proc2 = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
        DEPLOY_DRY_RUN: "false",
      });

      expect(proc2.status).toBe(0);
      const result2 = JSON.parse(proc2.stdout) as DeployResult;
      expect(result2.filesChanged).toContain("prompts/test-agent.txt");
      expect(readFileSync(resolve(configRoot, "prompts/test-agent.txt"), "utf-8")).toBe(
        "agent prompt body v2",
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports restartRequired when plugin changed", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "deploy-restart-"));
    const configRoot = resolve(tempRoot, "config");

    try {
      const bundleRoot = setupBundleRoot(tempRoot);
      writeFile(configRoot, "plugins/arcs.js", "// old plugin");

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
      });

      expect(proc.status).toBe(0);
      const result = JSON.parse(proc.stdout) as DeployResult;
      expect(result.restartRequired).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("includes restartGuidance in script output when restartRequired", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "deploy-guidance-"));
    const configRoot = resolve(tempRoot, "config");

    try {
      const bundleRoot = setupBundleRoot(tempRoot);
      writeFile(configRoot, "plugins/arcs.js", "// old plugin");

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
      });

      expect(proc.status).toBe(0);
      const result = JSON.parse(proc.stdout) as DeployResult;
      expect(result.restartRequired).toBe(true);
      expect(result.restartGuidance).toBe(
        "Plugin file changed. Restart opencode for changes to take effect.",
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("omits restartGuidance when restartRequired is false", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "deploy-no-guidance-"));
    const configRoot = resolve(tempRoot, "config");

    try {
      const bundleRoot = setupBundleRoot(tempRoot);
      // Pre-populate with identical content so no change
      writeFile(configRoot, "skills/arcs/planner/SKILL.md", "# Planner skill");
      writeFile(configRoot, "skills/arcs/planner/notes.md", "notes content");
      writeFile(configRoot, "plugins/arcs.js", "// plugin code");

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
      });

      expect(proc.status).toBe(0);
      const result = JSON.parse(proc.stdout) as DeployResult;
      expect(result.restartRequired).toBe(false);
      expect(result.restartGuidance).toBeUndefined();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("never copies from config to repo (no reverse sync)", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "deploy-noreverse-"));
    const configRoot = resolve(tempRoot, "config");

    try {
      const bundleRoot = setupBundleRoot(tempRoot);
      // Config has extra file that doesn't exist in bundle
      writeFile(configRoot, "skills/arcs/planner/custom.md", "user custom");

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
        DEPLOY_DRY_RUN: "false",
      });

      expect(proc.status).toBe(0);
      // The bundle should not have the custom file
      expect(existsSync(resolve(bundleRoot, "skills/planner/custom.md"))).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
