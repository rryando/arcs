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
  codegraphWired: boolean;
  rtkWired: boolean;
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
  writeFile(bundleRoot, "prompts/arcs-orchestrate.txt", "orchestrator prompt body");
  writeFile(
    bundleRoot,
    "manifest.json",
    JSON.stringify({
      agents: [
        {
          id: "software-engineer",
          status: "active",
          kind: "subagent",
          tier: "heavy",
          modes: ["opencode", "claudecode"],
          source: "prompts/software-engineer.txt",
          destination: "prompts/software-engineer.txt",
          description:
            "Implementation specialist. Writes code, runs tests, ships features. Loads quick-dev, code-agent, test-driven-development, and executing-plans skills as needed.",
          permissions: {
            edit: "allow",
            bash: "allow",
            webfetch: "allow",
            mcp: "allow",
            task: "deny",
          },
        },
        {
          id: "devil-advocate",
          status: "active",
          kind: "subagent",
          tier: "standard",
          modes: ["opencode", "claudecode"],
          source: "prompts/devil-advocate.txt",
          destination: "prompts/devil-advocate.txt",
          description:
            "Adversarial phase-gate agent. Checks work at phase boundaries using KISS/YAGNI/DRY principles. Runs tests, reads diffs, delivers pass/block verdicts. Cannot edit code.",
          permissions: {
            edit: "deny",
            bash: "allow",
            webfetch: "allow",
            mcp: "allow",
            task: "deny",
          },
        },
        {
          id: "arcs-orchestrate",
          status: "active",
          kind: "primary",
          tier: "standard",
          modes: ["opencode", "claudecode"],
          source: "prompts/arcs-orchestrate.txt",
          destination: "prompts/arcs-orchestrate.txt",
          description:
            "The central coordinator for executing plans, managing agent dispatch, and handling DAG workflows.",
          permissions: {
            edit: "allow",
            bash: "allow",
            webfetch: "allow",
            mcp: "allow",
            task: "allow",
          },
        },
      ],
    }),
  );
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

function mutateRegistry(
  bundleRoot: string,
  mutate: (agents: Array<Record<string, unknown>>) => void,
) {
  const manifestPath = resolve(bundleRoot, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  mutate(manifest.agents);
  writeFileSync(manifestPath, JSON.stringify(manifest));
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
      // Dry-run: files should NOT actually be written, no external wiring
      expect(existsSync(resolve(configRoot, "agents/software-engineer.md"))).toBe(false);
      expect(result.codegraphWired).toBe(false);
      expect(result.rtkWired).toBe(false);
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
      // Real-write deploys still skip external wiring under the test suite:
      // global-setup exports ARCS_SKIP_CODEGRAPH/ARCS_SKIP_RTK and the child
      // process inherits them, so the developer's host config is never touched.
      expect(result.codegraphWired).toBe(false);
      expect(result.rtkWired).toBe(false);

      // Verify actually written and contains correct frontmatter and system prompt
      const writtenContent = readFileSync(
        resolve(configRoot, "agents/software-engineer.md"),
        "utf-8",
      );
      expect(writtenContent).toContain("name: software-engineer");
      expect(writtenContent).toContain(
        "description: Implementation specialist. Writes code, runs tests, ships features. Loads quick-dev, code-agent, test-driven-development, and executing-plans skills as needed.",
      );
      expect(writtenContent).toContain("model: inherit");
      expect(writtenContent).toContain("tools: Read, Write, Edit, Glob, Grep, Bash");
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
      expect(writtenContent).toContain("name: software-engineer");
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
        "name: devil-advocate",
        "description: Adversarial phase-gate agent. Checks work at phase boundaries using KISS/YAGNI/DRY principles. Runs tests, reads diffs, delivers pass/block verdicts. Cannot edit code.",
        "model: inherit",
        "tools: Read, Glob, Grep, Bash",
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
        readFileSync(
          resolve(configRoot, "skills/arcs-to-diagram/scripts/manage-diagram.mjs"),
          "utf-8",
        ),
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
      expect(existsSync(resolve(projectRoot, ".claude/skills/arcs-to-diagram/SKILL.md"))).toBe(
        true,
      );
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

  it("does not prune agent files that are outside the active registry", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "claudecode-deploy-orphans-"));
    const configRoot = resolve(tempRoot, "config");

    try {
      const bundleRoot = setupBundleRoot(tempRoot);

      writeFile(configRoot, "agents/tech-architect.md", "some tech-architect prompt content");
      writeFile(configRoot, "agents/random-other.md", "some random content");

      // Dry-run first to verify identification of orphans without deletion
      const procDry = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
      });

      expect(procDry.status).toBe(0);
      const resultDry = JSON.parse(procDry.stdout) as DeployResult;
      expect(resultDry.filesRemoved).not.toContain("agents/tech-architect.md");
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
      expect(resultWrite.filesRemoved).not.toContain("agents/tech-architect.md");
      expect(resultWrite.filesRemoved).not.toContain("agents/random-other.md");

      expect(existsSync(resolve(configRoot, "agents/tech-architect.md"))).toBe(true);
      expect(existsSync(resolve(configRoot, "agents/random-other.md"))).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("retires only unchanged agent files proven owned by prior deploy metadata", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "claudecode-agent-retirement-"));
    const configRoot = resolve(tempRoot, "config");

    try {
      const bundleRoot = setupBundleRoot(tempRoot);
      expect(
        runDeploy({
          DEPLOY_BUNDLE_ROOT: bundleRoot,
          DEPLOY_CONFIG_ROOT: configRoot,
          DEPLOY_DRY_RUN: "false",
        }).status,
      ).toBe(0);
      writeFile(configRoot, "agents/random-other.md", "foreign");
      mutateRegistry(bundleRoot, (agents) => {
        agents[1].status = "retired";
        agents[1].replacementId = "software-engineer";
      });

      const dryRun = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
      });
      expect(dryRun.status).toBe(0);
      expect((JSON.parse(dryRun.stdout) as DeployResult).filesRemoved).toContain(
        "agents/devil-advocate.md",
      );
      expect(existsSync(resolve(configRoot, "agents/devil-advocate.md"))).toBe(true);

      const deployed = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
        DEPLOY_DRY_RUN: "false",
      });
      expect(deployed.status).toBe(0);
      expect(existsSync(resolve(configRoot, "agents/devil-advocate.md"))).toBe(false);
      expect(readFileSync(resolve(configRoot, "agents/random-other.md"), "utf-8")).toBe("foreign");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves a user-modified agent file when its registry record retires", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "claudecode-agent-retirement-modified-"));
    const configRoot = resolve(tempRoot, "config");

    try {
      const bundleRoot = setupBundleRoot(tempRoot);
      runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
        DEPLOY_DRY_RUN: "false",
      });
      writeFile(configRoot, "agents/devil-advocate.md", "user modified");
      mutateRegistry(bundleRoot, (agents) => {
        agents[1].status = "retired";
        agents[1].replacementId = "software-engineer";
      });

      const deployed = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
        DEPLOY_DRY_RUN: "false",
      });
      expect(deployed.status).toBe(0);
      expect((JSON.parse(deployed.stdout) as DeployResult).filesRemoved).not.toContain(
        "agents/devil-advocate.md",
      );
      expect(readFileSync(resolve(configRoot, "agents/devil-advocate.md"), "utf-8")).toBe(
        "user modified",
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("deploys only active agents and rejects unregistered prompt files", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "claudecode-deploy-registry-"));
    const configRoot = resolve(tempRoot, "config");

    try {
      const bundleRoot = setupBundleRoot(tempRoot);
      const manifestPath = resolve(bundleRoot, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      manifest.agents[1].status = "retired";
      manifest.agents[1].replacementId = "software-engineer";
      writeFileSync(manifestPath, JSON.stringify(manifest));

      const retired = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
      });
      expect(retired.status).toBe(0);
      expect((JSON.parse(retired.stdout) as DeployResult).filesAdded).not.toContain(
        "agents/devil-advocate.md",
      );

      writeFile(bundleRoot, "prompts/unregistered.txt", "must not deploy");
      const unregistered = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
      });
      expect(unregistered.status).toBe(1);
      expect(unregistered.stderr).toContain("Unregistered prompt file");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("deploys active Claude agents but ignores active OpenCode-only agents", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "claudecode-deploy-agent-modes-"));
    const configRoot = resolve(tempRoot, "config");

    try {
      const bundleRoot = setupBundleRoot(tempRoot);
      mutateRegistry(bundleRoot, (agents) => {
        agents[0].modes = ["opencode"];
        agents[1].modes = ["claudecode"];
      });

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
        DEPLOY_DRY_RUN: "false",
      });

      expect(proc.status).toBe(0);
      const result = JSON.parse(proc.stdout) as DeployResult;
      expect(result.filesAdded).toContain("agents/devil-advocate.md");
      expect(result.filesAdded).not.toContain("agents/software-engineer.md");
      expect(existsSync(resolve(configRoot, "agents/devil-advocate.md"))).toBe(true);
      expect(existsSync(resolve(configRoot, "agents/software-engineer.md"))).toBe(false);
      const installedManifest = JSON.parse(
        readFileSync(resolve(configRoot, ".arcs-bundle.json"), "utf-8"),
      );
      expect(installedManifest.agents.map((agent: { id: string }) => agent.id)).toEqual([
        "devil-advocate",
        "arcs-orchestrate",
      ]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "missing",
      (agents: Array<Record<string, unknown>>) => {
        agents[1].replacementId = "missing-agent";
      },
    ],
    [
      "wrong kind",
      (agents: Array<Record<string, unknown>>) => {
        agents[1].replacementId = "arcs-orchestrate";
      },
    ],
    [
      "missing deployment mode",
      (agents: Array<Record<string, unknown>>) => {
        agents[1].replacementId = "software-engineer";
        agents[0].modes = ["opencode"];
      },
    ],
  ])("rejects a retired agent with a %s replacement", (_label, makeIncompatible) => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "claudecode-deploy-retirement-invalid-"));

    try {
      const bundleRoot = setupBundleRoot(tempRoot);
      mutateRegistry(bundleRoot, (agents) => {
        agents[1].status = "retired";
        makeIncompatible(agents);
      });

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: resolve(tempRoot, "config"),
        DEPLOY_DRY_RUN: "false",
      });

      expect(proc.status).toBe(1);
      expect(proc.stderr).toMatch(/retired agent.*active compatible replacement.*kind and modes/i);
      expect(existsSync(resolve(tempRoot, "config"))).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ["traversal source", "source", "prompts/../outside.txt"],
    ["absolute source", "source", "/tmp/outside.txt"],
    ["non-txt source", "source", "prompts/software-engineer.md"],
    ["traversal destination", "destination", "prompts/../outside.txt"],
    ["empty destination segment", "destination", "prompts//software-engineer.txt"],
    ["dot destination segment", "destination", "prompts/./software-engineer.txt"],
    ["absolute destination", "destination", "/tmp/outside.txt"],
    ["non-txt destination", "destination", "prompts/software-engineer.md"],
    ["malformed id", "id", "../software-engineer"],
  ])("rejects registry records with %s", (_label, field, value) => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "claudecode-deploy-invalid-registry-"));
    const configRoot = resolve(tempRoot, "config");

    try {
      const bundleRoot = setupBundleRoot(tempRoot);
      mutateRegistry(bundleRoot, (agents) => {
        agents[0][field] = value;
      });

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
        DEPLOY_DRY_RUN: "false",
      });

      expect(proc.status).toBe(1);
      expect(proc.stderr).toContain("Invalid agent registry record");
      expect(existsSync(resolve(tempRoot, "outside.txt"))).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects duplicate prompt destinations", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "claudecode-deploy-duplicate-destination-"));

    try {
      const bundleRoot = setupBundleRoot(tempRoot);
      mutateRegistry(bundleRoot, (agents) => {
        agents[1].destination = agents[0].destination;
      });

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: resolve(tempRoot, "config"),
      });

      expect(proc.status).toBe(1);
      expect(proc.stderr).toContain("Duplicate agent registry destination");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("applies DEPLOY_MODEL_* tier env vars to compiled agent frontmatter", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "claudecode-deploy-models-"));
    const configRoot = resolve(tempRoot, "config");

    try {
      const bundleRoot = setupBundleRoot(tempRoot);

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
        DEPLOY_DRY_RUN: "false",
        DEPLOY_MODEL_HEAVY: "claude-opus-4-5",
        DEPLOY_MODEL_STANDARD: "claude-sonnet-4-5",
        DEPLOY_MODEL_LIGHT: "claude-haiku-3-5",
      });

      expect(proc.status).toBe(0);
      const result = JSON.parse(proc.stdout) as DeployResult & {
        modelConfig: { heavy: string; standard: string; light: string };
      };
      expect(result.modelConfig.heavy).toBe("claude-opus-4-5");
      expect(result.modelConfig.standard).toBe("claude-sonnet-4-5");
      expect(result.modelConfig.light).toBe("claude-haiku-3-5");

      // software-engineer is heavy tier
      const seContent = readFileSync(resolve(configRoot, "agents/software-engineer.md"), "utf-8");
      expect(seContent).toContain("model: claude-opus-4-5");

      // devil-advocate is standard tier
      const daContent = readFileSync(resolve(configRoot, "agents/devil-advocate.md"), "utf-8");
      expect(daContent).toContain("model: claude-sonnet-4-5");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("defaults to 'inherit' for all tiers when DEPLOY_MODEL_* env vars are not set", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "claudecode-deploy-models-default-"));
    const configRoot = resolve(tempRoot, "config");

    try {
      const bundleRoot = setupBundleRoot(tempRoot);

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
        DEPLOY_DRY_RUN: "false",
      });

      expect(proc.status).toBe(0);
      const seContent = readFileSync(resolve(configRoot, "agents/software-engineer.md"), "utf-8");
      expect(seContent).toContain("model: inherit");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
