import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const deployScript = resolve(root, "scripts/deploy-pi-bundle.mjs");

type DeployResult = {
  dryRun: boolean;
  platform: string;
  scope: string;
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
          modes: ["opencode", "claudecode", "pi"],
          source: "prompts/software-engineer.txt",
          destination: "prompts/software-engineer.txt",
          description: "Implementation specialist. Writes code, runs tests, ships features.",
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
          modes: ["opencode", "claudecode", "pi"],
          source: "prompts/devil-advocate.txt",
          destination: "prompts/devil-advocate.txt",
          description: "Adversarial phase-gate agent. Cannot edit code.",
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
          modes: ["opencode", "claudecode", "pi"],
          source: "prompts/arcs-orchestrate.txt",
          destination: "prompts/arcs-orchestrate.txt",
          description: "The central coordinator for executing plans.",
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
  }
  return bundleRoot;
}

describe("deploy-pi-bundle", () => {
  it("defaults to dry-run and reports files to add", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "pi-deploy-dry-"));
    const configRoot = resolve(tempRoot, "pi-home");

    try {
      const bundleRoot = setupBundleRoot(tempRoot);

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
      });

      expect(proc.status).toBe(0);
      const result = JSON.parse(proc.stdout) as DeployResult;
      expect(result.dryRun).toBe(true);
      expect(result.platform).toBe("pi");
      expect(result.scope).toBe("global");
      expect(result.filesAdded).toContain("agent/agents/software-engineer.md");
      expect(result.filesAdded).toContain("agent/agents/devil-advocate.md");
      expect(result.filesAdded).toContain("agent/agents/arcs-orchestrate.md");
      // Dry-run: files should NOT actually be written, no external wiring
      expect(existsSync(resolve(configRoot, "agent/agents/software-engineer.md"))).toBe(false);
      expect(result.codegraphWired).toBe(false);
      expect(result.rtkWired).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("compiles and writes files under configRoot/agent/agents/ with pi frontmatter when dryRun=false", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "pi-deploy-write-"));
    const configRoot = resolve(tempRoot, "pi-home");

    try {
      const bundleRoot = setupBundleRoot(tempRoot, { withSkills: true });

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
        DEPLOY_DRY_RUN: "false",
      });

      expect(proc.status).toBe(0);
      const result = JSON.parse(proc.stdout) as DeployResult;
      expect(result.dryRun).toBe(false);
      expect(result.filesAdded).toContain("agent/agents/software-engineer.md");

      // Writer agent: full builtin allowlist + mcp extension tools
      const se = readFileSync(resolve(configRoot, "agent/agents/software-engineer.md"), "utf-8");
      expect(se).toContain("name: software-engineer");
      expect(se).toContain(
        "description: Implementation specialist. Writes code, runs tests, ships features.",
      );
      expect(se).toContain("tools: read, grep, find, ls, write, edit, bash, ext:mcp");
      // `model: inherit` is the extension default and must be omitted
      expect(se).not.toContain("model:");
      // subagents (task: deny) get no nested delegation
      expect(se).not.toContain("allowed_subagents");
      expect(se).toContain("software engineer prompt body");

      // Read-only agent: no mutation tools
      const da = readFileSync(resolve(configRoot, "agent/agents/devil-advocate.md"), "utf-8");
      expect(da).toContain("tools: read, grep, find, ls, bash, ext:mcp");
      const daToolsLine = da.split("\n").find((line) => line.startsWith("tools: "));
      expect(daToolsLine).not.toContain(", write");
      expect(daToolsLine).not.toContain(", edit");

      // Primary orchestrator: task: allow mirrors to nested delegation
      const orch = readFileSync(resolve(configRoot, "agent/agents/arcs-orchestrate.md"), "utf-8");
      expect(orch).toContain("allowed_subagents: all");

      // Skills land under agent/skills/ with the arcs- namespace prefix
      const skill = readFileSync(
        resolve(configRoot, "agent/skills/arcs-brainstorming/SKILL.md"),
        "utf-8",
      );
      expect(skill).toContain("# brainstorming skill");
      const helper = readFileSync(
        resolve(configRoot, "agent/skills/arcs-brainstorming/scripts/helper.mjs"),
        "utf-8",
      );
      expect(helper).toContain("console.log('brainstorm helper');");

      // Installed manifest tracks ownership for later orphan pruning
      const installed = JSON.parse(
        readFileSync(resolve(configRoot, ".arcs-bundle.json"), "utf-8"),
      ) as { bundleId: string; agents: Array<{ id: string }> };
      expect(installed.bundleId).toBe("arcs-pi-bundle");
      expect(installed.agents.map((a) => a.id).sort()).toEqual([
        "arcs-orchestrate",
        "devil-advocate",
        "software-engineer",
      ]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("emits model frontmatter when a tier model is pinned via env", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "pi-deploy-model-"));
    const configRoot = resolve(tempRoot, "pi-home");

    try {
      const bundleRoot = setupBundleRoot(tempRoot);

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
        DEPLOY_DRY_RUN: "false",
        DEPLOY_MODEL_HEAVY: "deepseek/deepseek-v4",
      });

      expect(proc.status).toBe(0);
      const se = readFileSync(resolve(configRoot, "agent/agents/software-engineer.md"), "utf-8");
      expect(se).toContain("model: deepseek/deepseek-v4");
      // standard tier agents keep inherit → no model field
      const da = readFileSync(resolve(configRoot, "agent/agents/devil-advocate.md"), "utf-8");
      expect(da).not.toContain("model:");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("writes compiled files under projectRoot/.pi/agents/ when DEPLOY_SCOPE is project", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "pi-deploy-project-"));
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
      expect(result.scope).toBe("project");
      expect(result.destination).toBe(resolve(projectRoot, ".pi"));
      expect(result.filesAdded).toContain("agents/software-engineer.md");

      expect(existsSync(resolve(projectRoot, ".pi/agents/software-engineer.md"))).toBe(true);
      expect(existsSync(resolve(projectRoot, ".pi/skills/arcs-brainstorming/SKILL.md"))).toBe(true);
      expect(existsSync(resolve(projectRoot, ".pi/.arcs-bundle.json"))).toBe(true);
      // global layout must not be written
      expect(existsSync(resolve(projectRoot, ".pi/agent/agents/software-engineer.md"))).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("prunes orphaned arcs-* skills and prunes removed agents installed by a previous deploy", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "pi-deploy-prune-"));
    const configRoot = resolve(tempRoot, "pi-home");

    try {
      const bundleRoot = setupBundleRoot(tempRoot, { withSkills: true });

      // Simulate a previous deploy that installed a now-orphaned skill + agent
      writeFile(configRoot, "agent/skills/arcs-retired-skill/SKILL.md", "# old skill\n");
      writeFile(configRoot, "agent/agents/obsolete.md", "---\nname: obsolete\n---\nold");
      writeFile(
        configRoot,
        ".arcs-bundle.json",
        JSON.stringify({
          bundleId: "arcs-pi-bundle",
          agents: [
            {
              id: "obsolete",
              promptDestination: "agent/agents/obsolete.md",
              sourceHash: "deadbeef",
            },
          ],
        }),
      );

      const proc = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
        DEPLOY_DRY_RUN: "false",
      });

      expect(proc.status).toBe(0);
      const result = JSON.parse(proc.stdout) as DeployResult;
      expect(result.filesRemoved).toContain("agent/skills/arcs-retired-skill");
      expect(existsSync(resolve(configRoot, "agent/skills/arcs-retired-skill"))).toBe(false);
      // The obsolete agent is NOT registered as retired-for-pi, so its file
      // stays untouched (only skills orphans are pruned by namespace).
      expect(existsSync(resolve(configRoot, "agent/agents/obsolete.md"))).toBe(true);
      // Foreign (non-arcs) skills are never touched
      writeFile(configRoot, "agent/skills/omarchy/SKILL.md", "# user's own skill\n");
      const procAfter = runDeploy({
        DEPLOY_BUNDLE_ROOT: bundleRoot,
        DEPLOY_CONFIG_ROOT: configRoot,
        DEPLOY_DRY_RUN: "false",
      });
      expect(procAfter.status).toBe(0);
      expect(existsSync(resolve(configRoot, "agent/skills/omarchy/SKILL.md"))).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
