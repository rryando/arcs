#!/usr/bin/env node
// Deploy claudecode ARCS bundle from repo to Claude Code config.
//
// Direction: repo → config ONLY. Never writes config → repo.
//
// What gets deployed:
//   1. Sub-agent prompts → <destination>/agents/<stem>.md
//   2. Skills tree       → <destination>/skills/arcs-<name>/...
//      (Claude Code skills must be flat under skills/; we use the `arcs-`
//       prefix as a namespace so orphan pruning never touches user skills.)
//   3. Default agent     → settings.json `agent` field set to "arcs-orchestrate"
//
// Env vars:
//   DEPLOY_BUNDLE_ROOT   — override bundle root (default: opencode/arcs)
//   DEPLOY_CONFIG_ROOT   — override config root (default: ~/.claude)
//   DEPLOY_PROJECT_ROOT  — override project root (default: repository root)
//   DEPLOY_SCOPE         — `global` or `project` (default: `global`)
//   DEPLOY_DRY_RUN       — "false" to actually write; anything else = dry-run (default: dry-run)
//
// Outputs JSON to stdout: DeployResult
// Exit code: 0 on success, 1 on error.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { wireCodegraphMcp, wireRtk } from "./lib/bundle-helpers.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const defaultBundleRoot = resolve(repoRoot, "opencode/arcs");
const defaultConfigRoot = resolve(homedir(), ".claude");
const defaultProjectRoot = repoRoot;

const bundleRoot = process.env.DEPLOY_BUNDLE_ROOT
  ? resolve(repoRoot, process.env.DEPLOY_BUNDLE_ROOT)
  : defaultBundleRoot;

let configRoot;
if (process.env.DEPLOY_CONFIG_ROOT) {
  const rawPath = process.env.DEPLOY_CONFIG_ROOT;
  if (rawPath.startsWith("~/")) {
    configRoot = resolve(homedir(), rawPath.slice(2));
  } else if (rawPath === "~") {
    configRoot = homedir();
  } else {
    configRoot = resolve(homedir(), rawPath);
  }
} else {
  configRoot = defaultConfigRoot;
}

const projectRoot = process.env.DEPLOY_PROJECT_ROOT
  ? resolve(repoRoot, process.env.DEPLOY_PROJECT_ROOT)
  : defaultProjectRoot;

const scope = process.env.DEPLOY_SCOPE === "project" ? "project" : "global";
const dryRun = process.env.DEPLOY_DRY_RUN !== "false";

const destination = scope === "project" ? projectRoot : configRoot;

const DEFAULT_AGENT = "arcs-orchestrate";
const SKILL_PREFIX = "arcs-";

// ---------------------------------------------------------------------------
// Model tier configuration
// ---------------------------------------------------------------------------
// Env vars: DEPLOY_MODEL_HEAVY, DEPLOY_MODEL_STANDARD, DEPLOY_MODEL_LIGHT
// Each defaults to "inherit" if unset.
const tierModels = {
  heavy: process.env.DEPLOY_MODEL_HEAVY || "inherit",
  standard: process.env.DEPLOY_MODEL_STANDARD || "inherit",
  light: process.env.DEPLOY_MODEL_LIGHT || "inherit",
};

/** Maps each agent stem to a tier. Falls back to "standard". */
const agentTierMap = {
  "software-engineer": "heavy",
  "docs-researcher": "heavy",
  "arcs-docs": "heavy",
  "oncall-ops": "heavy",
  "system-architect": "heavy",
  "arcs-orchestrate": "standard",
  "arcs-orchestrate-caveman": "standard",
  "devil-advocate": "standard",
  "graph-explorer": "light",
  "code-reviewer": "light",
  "tech-architect": "light",
  "qa-analyst": "light",
};

// Agent descriptions mirror opencode/arcs/manifest.json (canonical) — keep in sync.
const agentMetadata = {
  "software-engineer": {
    name: "Software Engineer",
    description:
      "Implementation specialist. Writes code, runs tests, ships features. Loads quick-dev, code-agent, test-driven-development, and executing-plans skills as needed.",
    tools: "Read, Write, Edit, Glob, Grep, Bash",
    model: "inherit",
  },
  "devil-advocate": {
    name: "Devil's Advocate",
    description:
      "Adversarial phase-gate agent. Checks work at phase boundaries using KISS/YAGNI/DRY principles. Runs tests, reads diffs, delivers pass/block verdicts. Cannot edit code.",
    tools: "Read, Glob, Grep, Bash",
    model: "inherit",
  },
  "graph-explorer": {
    name: "Graph Explorer",
    description:
      "DAG-first codebase and knowledge exploration specialist. Queries arcs search, related, and context first, then codegraph MCP code-intelligence tools, before falling back to raw file-system tools. Replaces vanilla explore for ARCS projects.",
    tools: "Read, Glob, Grep, Bash",
    model: "inherit",
  },
  "tech-architect": {
    name: "Technical Architect",
    description:
      "Architecture and analysis specialist. Deep structural reasoning, refactor guidance, trade-off evaluation, and root cause analysis without making hasty edits.",
    tools: "Read, Glob, Grep, Bash",
    model: "inherit",
  },
  "code-reviewer": {
    name: "Code Reviewer",
    description:
      "Reviews code changes for production readiness and catches correctness, maintainability, and testing issues.",
    tools: "Read, Glob, Grep, Bash",
    model: "inherit",
  },
  "qa-analyst": {
    name: "QA Analyst",
    description:
      "Quality enforcement specialist. Proactive code audits, review dispatch, convention compliance.",
    tools: "Read, Glob, Grep, Bash",
    model: "inherit",
  },
  "system-architect": {
    name: "System Architect",
    description:
      "Architecture and design specialist. Module boundaries, dependency graphs, migration strategies, and cross-project design decisions.",
    tools: "Read, Glob, Grep, Bash",
    model: "inherit",
  },
  "arcs-docs": {
    name: "ARCS Docs Specialist",
    description:
      "ARCS documentation specialist. Manages plans, knowledge entries, diagrams, and DAG health. Knows ARCS structure intimately.",
    tools: "Read, Write, Edit, Glob, Grep, Bash",
    model: "inherit",
  },
  "docs-researcher": {
    name: "Docs Researcher",
    description:
      "Handles documentation writing, research synthesis, OCR-adjacent extraction, and document-heavy analysis tasks.",
    tools: "Read, Write, Edit, Glob, Grep, Bash",
    model: "inherit",
  },
  "oncall-ops": {
    name: "On-Call Ops",
    description:
      "Debugging and diagnosis specialist. Finds root causes through systematic investigation, log triage, bisect, and performance profiling.",
    tools: "Read, Write, Edit, Glob, Grep, Bash",
    model: "inherit",
  },
  "arcs-orchestrate": {
    name: "ARCS Orchestrator",
    description:
      "The central coordinator for executing plans, managing agent dispatch, and handling DAG workflows.",
    tools: "Read, Write, Edit, Glob, Grep, Bash",
    model: "inherit",
  },
  "arcs-orchestrate-caveman": {
    name: "ARCS Orchestrator (Caveman)",
    description:
      "A terse, high-efficiency orchestrator that drives tasks without extra commentary.",
    tools: "Read, Write, Edit, Glob, Grep, Bash",
    model: "inherit",
  },
};

function ensureParentDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function configRelativePath(suffix) {
  return scope === "project" ? `.claude/${suffix}` : suffix;
}

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Compile sub-agent prompts
// ---------------------------------------------------------------------------

function buildAgentSources() {
  const promptsDir = resolve(bundleRoot, "prompts");
  if (!existsSync(promptsDir)) {
    throw new Error(`Prompts directory not found at ${promptsDir}`);
  }

  const promptFiles = readdirSync(promptsDir).filter((f) => f.endsWith(".txt"));
  const sources = [];

  for (const file of promptFiles) {
    const stem = file.slice(0, -4);
    const sourcePath = resolve(promptsDir, file);
    const promptContent = readFileSync(sourcePath, "utf-8");

    const meta = agentMetadata[stem] || {
      name: stem
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" "),
      description: `ARCS ${stem} agent.`,
      tools: "Read, Write, Edit, Glob, Grep, Bash",
      model: "inherit",
    };

    const tier = agentTierMap[stem] || "standard";
    const model = tierModels[tier];

    const toolsArray = meta.tools.split(",").map((t) => t.trim());
    const toolsYaml = `[${toolsArray.map((t) => `"${t}"`).join(", ")}]`;

    const compiledContent = [
      "---",
      `name: ${meta.name}`,
      `description: ${meta.description}`,
      `model: ${model}`,
      `tools: ${toolsYaml}`,
      "---",
      "",
      promptContent,
    ].join("\n");

    sources.push({
      stem,
      compiledContent,
      configRelative: configRelativePath(`agents/${stem}.md`),
    });
  }

  return sources;
}

// ---------------------------------------------------------------------------
// 2. Walk skills tree
// ---------------------------------------------------------------------------

function buildSkillSources() {
  const skillsDir = resolve(bundleRoot, "skills");
  if (!existsSync(skillsDir)) return { skillNames: [], files: [] };

  const skillNames = readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const files = [];
  for (const skillName of skillNames) {
    const skillRoot = resolve(skillsDir, skillName);
    for (const absPath of walkFiles(skillRoot)) {
      const rel = relative(skillRoot, absPath).split(/[\\/]/).join("/");
      files.push({
        skillName,
        absSource: absPath,
        configRelative: configRelativePath(`skills/${SKILL_PREFIX}${skillName}/${rel}`),
      });
    }
  }

  return { skillNames, files };
}

// ---------------------------------------------------------------------------
// 3. settings.json merge — set default agent
// ---------------------------------------------------------------------------

function planSettingsUpdate() {
  const settingsConfigRelative = configRelativePath("settings.json");
  const settingsAbsolute = resolve(destination, settingsConfigRelative);

  let existing = null;
  let parsed = {};
  if (existsSync(settingsAbsolute)) {
    existing = readFileSync(settingsAbsolute, "utf-8");
    try {
      parsed = JSON.parse(existing);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        parsed = {};
      }
    } catch {
      // Malformed JSON — preserve as-is by skipping the merge.
      return { settingsConfigRelative, settingsAbsolute, status: "skipped-malformed" };
    }
  }

  const merged = { ...parsed, agent: DEFAULT_AGENT };
  const serialized = `${JSON.stringify(merged, null, 2)}\n`;

  let status;
  if (existing === null) {
    status = "added";
  } else if (existing === serialized) {
    status = "unchanged";
  } else {
    status = "changed";
  }

  return { settingsConfigRelative, settingsAbsolute, status, serialized };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const agentSources = buildAgentSources();
  const skillSources = buildSkillSources();
  const settingsPlan = planSettingsUpdate();

  // Pass 1: Classify add/change/unchanged for every planned write
  const filesAdded = [];
  const filesChanged = [];
  const filesUnchanged = [];

  for (const { compiledContent, configRelative } of agentSources) {
    const abs = resolve(destination, configRelative);
    if (!existsSync(abs)) {
      filesAdded.push(configRelative);
    } else if (readFileSync(abs, "utf-8") !== compiledContent) {
      filesChanged.push(configRelative);
    } else {
      filesUnchanged.push(configRelative);
    }
  }

  for (const { absSource, configRelative } of skillSources.files) {
    const abs = resolve(destination, configRelative);
    const sourceContent = readFileSync(absSource);
    if (!existsSync(abs)) {
      filesAdded.push(configRelative);
    } else {
      const existing = readFileSync(abs);
      if (Buffer.compare(existing, sourceContent) !== 0) {
        filesChanged.push(configRelative);
      } else {
        filesUnchanged.push(configRelative);
      }
    }
  }

  if (settingsPlan.status === "added") {
    filesAdded.push(settingsPlan.settingsConfigRelative);
  } else if (settingsPlan.status === "changed") {
    filesChanged.push(settingsPlan.settingsConfigRelative);
  } else if (settingsPlan.status === "unchanged") {
    filesUnchanged.push(settingsPlan.settingsConfigRelative);
  }
  // status "skipped-malformed" intentionally omitted from all lists

  // Orphans
  const filesRemoved = [];

  // Agent orphans — only `.md` files whose stem we recognize from agentMetadata
  const agentsTargetDir = resolve(destination, configRelativePath("agents"));
  const activeAgentStems = new Set(agentSources.map((f) => f.stem));
  if (existsSync(agentsTargetDir)) {
    for (const entry of readdirSync(agentsTargetDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const stem = entry.name.slice(0, -3);
        if (agentMetadata[stem] && !activeAgentStems.has(stem)) {
          filesRemoved.push(configRelativePath(`agents/${entry.name}`));
        }
      }
    }
  }

  // Skill orphans — only `arcs-*/` directories that aren't in current source.
  // The prefix gives us a safe namespace; foreign user skills are never touched.
  const skillsTargetDir = resolve(destination, configRelativePath("skills"));
  const activeSkillDirs = new Set(skillSources.skillNames.map((n) => `${SKILL_PREFIX}${n}`));
  const orphanSkillDirs = [];
  if (existsSync(skillsTargetDir)) {
    for (const entry of readdirSync(skillsTargetDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(SKILL_PREFIX)) {
        if (!activeSkillDirs.has(entry.name)) {
          orphanSkillDirs.push(entry.name);
          filesRemoved.push(configRelativePath(`skills/${entry.name}`));
        }
      }
    }
  }

  // Pass 2: Write if not dry-run
  if (!dryRun) {
    for (const { compiledContent, configRelative } of agentSources) {
      const abs = resolve(destination, configRelative);
      ensureParentDir(abs);
      writeFileSync(abs, compiledContent, "utf-8");
    }

    for (const { absSource, configRelative } of skillSources.files) {
      const abs = resolve(destination, configRelative);
      ensureParentDir(abs);
      writeFileSync(abs, readFileSync(absSource));
    }

    if (settingsPlan.serialized) {
      ensureParentDir(settingsPlan.settingsAbsolute);
      writeFileSync(settingsPlan.settingsAbsolute, settingsPlan.serialized, "utf-8");
    }

    for (const fileToRemove of filesRemoved) {
      const abs = resolve(destination, fileToRemove);
      if (existsSync(abs)) {
        // Could be a file (agent orphan) or directory (skill orphan)
        const isDir = statSync(abs).isDirectory();
        rmSync(abs, { recursive: isDir, force: true });
      }
    }
  }

  // Best-effort: wire the codegraph MCP server. Skipped on dry-run; never fatal.
  const codegraphWired = dryRun ? false : wireCodegraphMcp("claude");

  // Best-effort: wire RTK instructions + hook. `rtk init -g` only writes the
  // user-global config, so project-scoped deploys skip it. Skipped on dry-run;
  // never fatal.
  const rtkWired = dryRun || scope === "project" ? false : wireRtk("claude");

  const result = {
    dryRun,
    source: bundleRoot,
    destination,
    modelConfig: tierModels,
    filesAdded,
    filesChanged,
    filesRemoved,
    filesUnchanged,
    codegraphWired,
    rtkWired,
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
