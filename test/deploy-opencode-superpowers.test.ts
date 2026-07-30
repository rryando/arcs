import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

type DeployManifest = {
  skills: { source: string; destination: string };
  agents: Array<{
    id?: string;
    status?: "active" | "retired";
    replacementId?: string;
    kind?: "primary" | "subagent";
    modes?: Array<"opencode" | "claudecode">;
    source: string;
    destination: string;
  }>;
  ownedPaths: string[];
  plugin: { source: string; destination: string };
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

function updateManifest(bundleRoot: string, mutate: (manifest: DeployManifest) => void) {
  const manifestPath = resolve(bundleRoot, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as DeployManifest;
  mutate(manifest);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

describe("deploy-opencode-bundle", () => {
  it.each([
    ["skills source", (manifest: DeployManifest) => (manifest.skills.source = "../outside-skills")],
    [
      "skills destination",
      (manifest: DeployManifest) => (manifest.skills.destination = "../outside-skills"),
    ],
    ["owned path", (manifest: DeployManifest) => (manifest.ownedPaths = ["../foreign"])],
    [
      "agent source",
      (manifest: DeployManifest) =>
        (manifest.agents = [{ source: "skills/agent.txt", destination: "prompts/agent.txt" }]),
    ],
    [
      "agent destination",
      (manifest: DeployManifest) =>
        (manifest.agents = [{ source: "prompts/agent.txt", destination: "/tmp/agent.txt" }]),
    ],
    ["plugin source", (manifest: DeployManifest) => (manifest.plugin.source = "../arcs.js")],
    [
      "plugin destination",
      (manifest: DeployManifest) => (manifest.plugin.destination = "prompts/arcs.js"),
    ],
  ])("rejects an escaping %s path before filesystem operations", (_name, mutate) => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "deploy-escape-"));
    const configRoot = resolve(tempRoot, "config");
    const foreignPath = resolve(tempRoot, "foreign", "keep.txt");

    try {
      const bundleRoot = setupBundleRoot(tempRoot);
      writeFile(tempRoot, "foreign/keep.txt", "keep");
      updateManifest(bundleRoot, mutate);

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
        DEPLOY_DRY_RUN: "false",
      });

      expect(proc.status).toBe(1);
      expect(proc.stderr).toMatch(/invalid declared runtime path/i);
      expect(readFileSync(foreignPath, "utf-8")).toBe("keep");
      expect(existsSync(configRoot)).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

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

  it("preserves removed agent destinations and foreign files outside owned paths", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "deploy-preserve-"));
    const configRoot = resolve(tempRoot, "config");
    const removedPrompt = resolve(configRoot, "prompts/removed-agent.txt");
    const foreignFile = resolve(configRoot, "foreign/custom.txt");

    try {
      const bundleRoot = setupBundleRoot(tempRoot);
      writeFile(configRoot, "prompts/removed-agent.txt", "user prompt");
      writeFile(configRoot, "foreign/custom.txt", "foreign");

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
        DEPLOY_DRY_RUN: "false",
      });

      expect(proc.status).toBe(0);
      const result = JSON.parse(proc.stdout) as DeployResult;
      expect(result.filesRemoved).not.toContain("prompts/removed-agent.txt");
      expect(readFileSync(removedPrompt, "utf-8")).toBe("user prompt");
      expect(readFileSync(foreignFile, "utf-8")).toBe("foreign");
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
            id: "test-agent",
            status: "active",
            kind: "subagent",
            modes: ["opencode", "claudecode"],
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

  it("deploys and records ownership only for active OpenCode agents", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "deploy-agent-modes-"));
    const configRoot = resolve(tempRoot, "config");

    try {
      const bundleRoot = setupBundleRoot(tempRoot);
      updateManifest(bundleRoot, (manifest) => {
        manifest.agents = [
          {
            id: "opencode-agent",
            status: "active",
            kind: "subagent",
            modes: ["opencode"],
            source: "prompts/opencode-agent.txt",
            destination: "prompts/opencode-agent.txt",
          },
          {
            id: "claudecode-agent",
            status: "active",
            kind: "subagent",
            modes: ["claudecode"],
            source: "prompts/claudecode-agent.txt",
            destination: "prompts/claudecode-agent.txt",
          },
        ];
      });
      writeFile(bundleRoot, "prompts/opencode-agent.txt", "OpenCode prompt");
      writeFile(bundleRoot, "prompts/claudecode-agent.txt", "Claude Code prompt");

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
        DEPLOY_DRY_RUN: "false",
      });

      expect(proc.status).toBe(0);
      const result = JSON.parse(proc.stdout) as DeployResult;
      expect(result.filesAdded).toContain("prompts/opencode-agent.txt");
      expect(result.filesAdded).not.toContain("prompts/claudecode-agent.txt");
      expect(existsSync(resolve(configRoot, "prompts/opencode-agent.txt"))).toBe(true);
      expect(existsSync(resolve(configRoot, "prompts/claudecode-agent.txt"))).toBe(false);
      const installedManifest = JSON.parse(
        readFileSync(resolve(configRoot, ".arcs-bundle.json"), "utf-8"),
      );
      expect(installedManifest.agents.map((agent: { id: string }) => agent.id)).toEqual([
        "opencode-agent",
      ]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves OpenCode-owned prompt and config when a Claude-only agent retires", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "deploy-claude-only-retirement-"));
    const configRoot = resolve(tempRoot, "config");

    try {
      const bundleRoot = setupBundleRoot(tempRoot);
      updateManifest(bundleRoot, (manifest) => {
        manifest.agents = [
          {
            id: "legacy-agent",
            status: "active",
            kind: "subagent",
            modes: ["opencode", "claudecode"],
            source: "prompts/legacy-agent.txt",
            destination: "prompts/legacy-agent.txt",
          },
        ];
      });
      writeFile(bundleRoot, "prompts/legacy-agent.txt", "managed prompt");
      expect(
        runDeploy({
          DEPLOY_BUNDLE_ROOT: bundleRoot,
          DEPLOY_CONFIG_ROOT: configRoot,
          DEPLOY_DRY_RUN: "false",
        }).status,
      ).toBe(0);

      const agentConfig = { prompt: "{file:prompts/legacy-agent.txt}", model: "user/model" };
      writeFile(
        configRoot,
        "opencode.json",
        JSON.stringify({ agent: { "legacy-agent": agentConfig } }),
      );
      const installedManifestPath = resolve(configRoot, ".arcs-bundle.json");
      const installedManifest = JSON.parse(readFileSync(installedManifestPath, "utf-8"));
      installedManifest.agents[0].configKey = "legacy-agent";
      installedManifest.agents[0].configHash = createHash("sha256")
        .update(JSON.stringify({ prompt: agentConfig.prompt }))
        .digest("hex");
      writeFileSync(installedManifestPath, JSON.stringify(installedManifest));

      updateManifest(bundleRoot, (manifest) => {
        manifest.agents[0].status = "retired";
        manifest.agents[0].modes = ["claudecode"];
        manifest.agents[0].replacementId = "claude-replacement";
        manifest.agents.push({
          id: "claude-replacement",
          status: "active",
          kind: "subagent",
          modes: ["claudecode"],
          source: "prompts/claude-replacement.txt",
          destination: "prompts/claude-replacement.txt",
        });
      });
      writeFile(bundleRoot, "prompts/claude-replacement.txt", "Claude replacement");

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
        DEPLOY_DRY_RUN: "false",
      });

      expect(proc.status).toBe(0);
      expect((JSON.parse(proc.stdout) as DeployResult).filesRemoved).not.toContain(
        "prompts/legacy-agent.txt",
      );
      expect(readFileSync(resolve(configRoot, "prompts/legacy-agent.txt"), "utf-8")).toBe(
        "managed prompt",
      );
      expect(JSON.parse(readFileSync(resolve(configRoot, "opencode.json"), "utf-8")).agent).toEqual(
        {
          "legacy-agent": agentConfig,
        },
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("retires an unchanged managed prompt but preserves modified and foreign prompts", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "deploy-agent-retirement-"));
    const configRoot = resolve(tempRoot, "config");

    try {
      const bundleRoot = setupBundleRoot(tempRoot);
      updateManifest(bundleRoot, (manifest) => {
        manifest.agents = [
          {
            id: "test-agent",
            status: "active",
            kind: "subagent",
            modes: ["opencode", "claudecode"],
            source: "prompts/test-agent.txt",
            destination: "prompts/test-agent.txt",
          },
        ];
      });
      writeFile(bundleRoot, "prompts/test-agent.txt", "managed prompt");

      expect(
        runDeploy({
          DEPLOY_BUNDLE_ROOT: bundleRoot,
          DEPLOY_CONFIG_ROOT: configRoot,
          DEPLOY_DRY_RUN: "false",
        }).status,
      ).toBe(0);
      writeFile(configRoot, "prompts/foreign.txt", "foreign");

      updateManifest(bundleRoot, (manifest) => {
        manifest.agents[0].status = "retired";
        manifest.agents[0].replacementId = "replacement-agent";
        manifest.agents.push({
          id: "replacement-agent",
          status: "active",
          kind: "subagent",
          modes: ["opencode", "claudecode"],
          source: "prompts/replacement-agent.txt",
          destination: "prompts/replacement-agent.txt",
        });
      });
      writeFile(bundleRoot, "prompts/replacement-agent.txt", "replacement prompt");
      const dryRun = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
      });
      expect(dryRun.status).toBe(0);
      expect((JSON.parse(dryRun.stdout) as DeployResult).filesRemoved).toContain(
        "prompts/test-agent.txt",
      );
      expect(existsSync(resolve(configRoot, "prompts/test-agent.txt"))).toBe(true);

      const deployed = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
        DEPLOY_DRY_RUN: "false",
      });
      expect(deployed.status).toBe(0);
      expect(existsSync(resolve(configRoot, "prompts/test-agent.txt"))).toBe(false);
      expect(readFileSync(resolve(configRoot, "prompts/foreign.txt"), "utf-8")).toBe("foreign");

      updateManifest(bundleRoot, (manifest) => {
        manifest.agents = manifest.agents.filter((agent) => agent.id === "test-agent");
        manifest.agents[0].status = "active";
        delete manifest.agents[0].replacementId;
      });
      runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
        DEPLOY_DRY_RUN: "false",
      });
      writeFile(configRoot, "prompts/test-agent.txt", "user modified");
      updateManifest(bundleRoot, (manifest) => {
        manifest.agents[0].status = "retired";
        manifest.agents[0].replacementId = "replacement-agent";
        manifest.agents.push({
          id: "replacement-agent",
          status: "active",
          kind: "subagent",
          modes: ["opencode", "claudecode"],
          source: "prompts/replacement-agent.txt",
          destination: "prompts/replacement-agent.txt",
        });
      });
      const preserved = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
        DEPLOY_DRY_RUN: "false",
      });
      expect(preserved.status).toBe(0);
      expect((JSON.parse(preserved.stdout) as DeployResult).filesRemoved).not.toContain(
        "prompts/test-agent.txt",
      );
      expect(readFileSync(resolve(configRoot, "prompts/test-agent.txt"), "utf-8")).toBe(
        "user modified",
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it.each([
    undefined,
    "enabled",
    "ACTIVE",
  ])("rejects malformed agent status %s before deployment", (status) => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "deploy-agent-status-"));
    const configRoot = resolve(tempRoot, "config");
    try {
      const bundleRoot = setupBundleRoot(tempRoot);
      updateManifest(bundleRoot, (manifest) => {
        manifest.agents = [
          {
            id: "test-agent",
            ...(status === undefined ? {} : { status: status as "active" }),
            kind: "subagent",
            modes: ["opencode", "claudecode"],
            source: "prompts/test-agent.txt",
            destination: "prompts/test-agent.txt",
          },
        ];
      });
      writeFile(bundleRoot, "prompts/test-agent.txt", "must not deploy");

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
        DEPLOY_DRY_RUN: "false",
      });

      expect(proc.status).toBe(1);
      expect(proc.stderr).toMatch(/invalid agent registry.*status/i);
      expect(existsSync(configRoot)).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects retirement when the replacement is not active and compatible", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "deploy-agent-replacement-"));
    const configRoot = resolve(tempRoot, "config");
    try {
      const bundleRoot = setupBundleRoot(tempRoot);
      updateManifest(bundleRoot, (manifest) => {
        manifest.agents = [
          {
            id: "retired-agent",
            status: "retired",
            replacementId: "missing-agent",
            kind: "subagent",
            modes: ["opencode", "claudecode"],
            source: "prompts/retired-agent.txt",
            destination: "prompts/retired-agent.txt",
          },
        ];
      });

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
        DEPLOY_DRY_RUN: "false",
      });

      expect(proc.status).toBe(1);
      expect(proc.stderr).toMatch(/retired agent.*replacement/i);
      expect(existsSync(configRoot)).toBe(false);
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
