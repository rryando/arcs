import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const deployScript = resolve(root, "scripts/deploy-claudecode-bundle.mjs");

type DeployResult = {
  dryRun: boolean;
  source: string;
  destination: string;
  filesAdded: string[];
  filesChanged: string[];
  filesRemoved: string[];
  filesUnchanged: string[];
};

function writeFile(rootPath: string, relativePath: string, content: string) {
  const outputPath = resolve(rootPath, relativePath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content, "utf-8");
}

function runDeploy(env: Record<string, string>) {
  return spawnSync("node", [deployScript], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf-8",
  });
}

function setupBundleRoot(tempRoot: string, opts: { withSkills?: boolean } = {}) {
  const bundleRoot = resolve(tempRoot, "bundle");
  writeFile(bundleRoot, "prompts/software-engineer.txt", "software engineer prompt body");
  writeFile(bundleRoot, "prompts/devil-advocate.txt", "devil's advocate prompt body");
  if (opts.withSkills) {
    writeFile(bundleRoot, "skills/brainstorming/SKILL.md", "# brainstorming skill\n");
    writeFile(
      bundleRoot,
      "skills/brainstorming/scripts/helper.mjs",
      "console.log('brainstorm helper');\n",
    );
    writeFile(bundleRoot, "skills/to-diagram/SKILL.md", "# to-diagram skill\n");
    writeFile(
      bundleRoot,
      "skills/to-diagram/scripts/manage-diagram.mjs",
      "console.log('diagram cli');\n",
    );
  }
  return bundleRoot;
}

describe("deploy-claudecode-bundle", () => {
  it("defaults to dry-run and reports files to add", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "claudecode-deploy-dry-"));
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
      expect(result.filesAdded).toContain("agents/software-engineer.md");
      expect(result.filesAdded).toContain("agents/devil-advocate.md");
      // Dry-run: files should NOT actually be written
      expect(existsSync(resolve(configRoot, "agents/software-engineer.md"))).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("compiles and writes files under configRoot/agents/ with correct frontmatter when dryRun=false", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "claudecode-deploy-write-"));
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
      expect(result.filesAdded).toContain("agents/software-engineer.md");
      expect(result.filesAdded).toContain("agents/devil-advocate.md");

      // Verify actually written and contains correct frontmatter and system prompt
      const writtenContent = readFileSync(
        resolve(configRoot, "agents/software-engineer.md"),
        "utf-8",
      );
      expect(writtenContent).toContain("name: Software Engineer");
      expect(writtenContent).toContain(
        "description: Implementation specialist. Writes code, runs tests, and ships features.",
      );
      expect(writtenContent).toContain("model: inherit");
      expect(writtenContent).toContain('tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"]');
      expect(writtenContent).toContain("software engineer prompt body");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("writes compiled files under projectRoot/.claude/agents/ when DEPLOY_SCOPE is project", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "claudecode-deploy-project-"));
    const projectRoot = resolve(tempRoot, "project");

    try {
      const bundleRoot = setupBundleRoot(tempRoot);

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_PROJECT_ROOT: projectRoot,
        DEPLOY_SCOPE: "project",
        DEPLOY_DRY_RUN: "false",
      });

      expect(proc.status).toBe(0);
      const result = JSON.parse(proc.stdout) as DeployResult;
      expect(result.dryRun).toBe(false);
      expect(result.destination).toBe(projectRoot);
      expect(result.filesAdded).toContain(".claude/agents/software-engineer.md");
      expect(result.filesAdded).toContain(".claude/agents/devil-advocate.md");

      expect(existsSync(resolve(projectRoot, ".claude/agents/software-engineer.md"))).toBe(true);
      const writtenContent = readFileSync(
        resolve(projectRoot, ".claude/agents/software-engineer.md"),
        "utf-8",
      );
      expect(writtenContent).toContain("name: Software Engineer");
      expect(writtenContent).toContain("software engineer prompt body");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("detects changed and unchanged files when files already exist in destination", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "claudecode-deploy-change-"));
    const configRoot = resolve(tempRoot, "config");

    try {
      const bundleRoot = setupBundleRoot(tempRoot);

      // Pre-populate with one changed and one unchanged file
      // Since it's global scope by default:
      // software-engineer should be changed:
      writeFile(configRoot, "agents/software-engineer.md", "old content that is different");
      // devil-advocate should be unchanged:
      const compiledDevilAdvocate = [
        "---",
        "name: Devil's Advocate",
        "description: Adversarial phase-gate agent. Checks work using KISS/YAGNI/DRY principles.",
        "model: inherit",
        'tools: ["Read", "Glob", "Grep", "Bash"]',
        "---",
        "",
        "devil's advocate prompt body",
      ].join("\n");
      writeFile(configRoot, "agents/devil-advocate.md", compiledDevilAdvocate);

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
      });

      expect(proc.status).toBe(0);
      const result = JSON.parse(proc.stdout) as DeployResult;
      expect(result.filesChanged).toContain("agents/software-engineer.md");
      expect(result.filesUnchanged).toContain("agents/devil-advocate.md");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("deploys skills under skills/arcs-<name>/ preserving subdirectories", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "claudecode-deploy-skills-"));
    const configRoot = resolve(tempRoot, "config");

    try {
      const bundleRoot = setupBundleRoot(tempRoot, { withSkills: true });

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
        DEPLOY_DRY_RUN: "false",
      });

      expect(proc.status).toBe(0);
      const result = JSON.parse(proc.stdout) as DeployResult;
      expect(result.filesAdded).toContain("skills/arcs-brainstorming/SKILL.md");
      expect(result.filesAdded).toContain("skills/arcs-brainstorming/scripts/helper.mjs");
      expect(result.filesAdded).toContain("skills/arcs-to-diagram/SKILL.md");
      expect(result.filesAdded).toContain("skills/arcs-to-diagram/scripts/manage-diagram.mjs");

      expect(existsSync(resolve(configRoot, "skills/arcs-brainstorming/SKILL.md"))).toBe(true);
      expect(
        readFileSync(resolve(configRoot, "skills/arcs-to-diagram/scripts/manage-diagram.mjs"), "utf-8"),
      ).toBe("console.log('diagram cli');\n");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("deploys skills to .claude/skills/arcs-<name>/ under project scope", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "claudecode-deploy-skills-proj-"));
    const projectRoot = resolve(tempRoot, "project");

    try {
      const bundleRoot = setupBundleRoot(tempRoot, { withSkills: true });

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_PROJECT_ROOT: projectRoot,
        DEPLOY_SCOPE: "project",
        DEPLOY_DRY_RUN: "false",
      });

      expect(proc.status).toBe(0);
      const result = JSON.parse(proc.stdout) as DeployResult;
      expect(result.filesAdded).toContain(".claude/skills/arcs-brainstorming/SKILL.md");
      expect(
        existsSync(resolve(projectRoot, ".claude/skills/arcs-to-diagram/SKILL.md")),
      ).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("sets default agent to arcs-orchestrate in settings.json and preserves existing fields", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "claudecode-deploy-settings-"));
    const configRoot = resolve(tempRoot, "config");

    try {
      const bundleRoot = setupBundleRoot(tempRoot);
      writeFile(
        configRoot,
        "settings.json",
        `${JSON.stringify({ theme: "dark", model: "claude-opus" }, null, 2)}\n`,
      );

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
        DEPLOY_DRY_RUN: "false",
      });

      expect(proc.status).toBe(0);
      const result = JSON.parse(proc.stdout) as DeployResult;
      expect(result.filesChanged).toContain("settings.json");

      const merged = JSON.parse(readFileSync(resolve(configRoot, "settings.json"), "utf-8"));
      expect(merged.agent).toBe("arcs-orchestrate");
      expect(merged.theme).toBe("dark");
      expect(merged.model).toBe("claude-opus");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("creates settings.json with default agent if it does not exist", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "claudecode-deploy-settings-new-"));
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
      expect(result.filesAdded).toContain("settings.json");

      const created = JSON.parse(readFileSync(resolve(configRoot, "settings.json"), "utf-8"));
      expect(created.agent).toBe("arcs-orchestrate");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("prunes orphan arcs-* skill directories but leaves foreign skills alone", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "claudecode-deploy-skills-orphan-"));
    const configRoot = resolve(tempRoot, "config");

    try {
      const bundleRoot = setupBundleRoot(tempRoot, { withSkills: true });

      // Pre-populate destination with:
      //  - an ARCS-owned skill no longer in source (should be pruned)
      //  - a foreign user skill (should be preserved)
      writeFile(configRoot, "skills/arcs-stale-skill/SKILL.md", "stale arcs skill");
      writeFile(configRoot, "skills/user-custom/SKILL.md", "user-owned skill");

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
        DEPLOY_DRY_RUN: "false",
      });

      expect(proc.status).toBe(0);
      const result = JSON.parse(proc.stdout) as DeployResult;
      expect(result.filesRemoved).toContain("skills/arcs-stale-skill");
      expect(result.filesRemoved).not.toContain("skills/user-custom");

      expect(existsSync(resolve(configRoot, "skills/arcs-stale-skill"))).toBe(false);
      expect(existsSync(resolve(configRoot, "skills/user-custom/SKILL.md"))).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("identifies known agent stems no longer in source as orphans and removes them", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "claudecode-deploy-orphans-"));
    const configRoot = resolve(tempRoot, "config");

    try {
      const bundleRoot = setupBundleRoot(tempRoot);

      // Pre-populate with:
      // 1. A valid active agent file (which will be unchanged/changed)
      // 2. An older sub-agent file whose stem is in agentMetadata but not in source (orphan)
      // 3. A file that is not in agentMetadata and not in source (should NOT be marked as orphan or deleted)
      writeFile(configRoot, "agents/tech-architect.md", "some tech-architect prompt content");
      writeFile(configRoot, "agents/random-other.md", "some random content");

      // Dry-run first to verify identification of orphans without deletion
      const procDry = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
      });

      expect(procDry.status).toBe(0);
      const resultDry = JSON.parse(procDry.stdout) as DeployResult;
      expect(resultDry.filesRemoved).toContain("agents/tech-architect.md");
      expect(resultDry.filesRemoved).not.toContain("agents/random-other.md");
      expect(existsSync(resolve(configRoot, "agents/tech-architect.md"))).toBe(true);

      // Real write to verify actual cleanup of orphan
      const procWrite = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
        DEPLOY_DRY_RUN: "false",
      });

      expect(procWrite.status).toBe(0);
      const resultWrite = JSON.parse(procWrite.stdout) as DeployResult;
      expect(resultWrite.filesRemoved).toContain("agents/tech-architect.md");
      expect(resultWrite.filesRemoved).not.toContain("agents/random-other.md");

      expect(existsSync(resolve(configRoot, "agents/tech-architect.md"))).toBe(false);
      expect(existsSync(resolve(configRoot, "agents/random-other.md"))).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
