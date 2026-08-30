#!/usr/bin/env node

// Deploy pi ARCS bundle from repo to pi config.
//
// Direction: repo → config ONLY. Never writes config → repo.
//
// What gets deployed:
//   1. Sub-agent prompts → <destination>/agent/agents/<stem>.md   (global)
//                          <destination>/.pi/agents/<stem>.md     (project)
//   2. Skills tree       → <destination>/agent/skills/arcs-<name>/...  (global)
//                          <destination>/.pi/skills/arcs-<name>/...    (project)
//
// The compiled agent format targets the pi subagents extension
// (@tintinweb/pi-subagents) custom agent types: a Claude Code-shaped
// .md with YAML frontmatter in pi's agent directory. pi's main session is
// the orchestrator, so there is no settings.json default-agent merge —
// every agent (including the arcs-* primary prompts) deploys as a spawnable
// subagent type via the `Agent` tool / `@type` mentions.
//
// Frontmatter mapping (ARCS manifest → pi agent type):
//   - `model: inherit` is OMITTED — "inherit parent" is the extension default.
//     A pinned DEPLOY_MODEL_* value emits `model: <value>` instead.
//   - permissions → `tools:` allowlist: edit→write/edit, bash→bash,
//     mcp→ext:mcp, base read-only set read/grep/find/ls. Read-only
//     specialists (code-reviewer, tech-architect, graph-explorer) get no
//     mutation tools.
//   - `task: allow` (primaries only) → `allowed_subagents: all`, mirroring
//     the Task tool those prompts were written against.
//
// Env vars:
//   DEPLOY_BUNDLE_ROOT  — override bundle root (default: opencode/arcs)
//   DEPLOY_CONFIG_ROOT  — override config root (default: ~/.pi)
//   DEPLOY_PROJECT_ROOT — override project root (default: repository root)
//   DEPLOY_SCOPE        — `global` or `project` (default: `global`)
//   DEPLOY_DRY_RUN      — "false" to actually write; anything else = dry-run (default: dry-run)
//   DEPLOY_MODEL_HEAVY/STANDARD/LIGHT — 3-tier model overrides (default: "inherit")
//
// Outputs JSON to stdout: DeployResult. Exit code 0 on success, 1 on error.
// codegraph/rtk are never wired: neither tool supports a pi install target.

import { createHash } from "node:crypto";
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
import {
  isActiveAgentForMode,
  isRetiredAgentForMode,
  validateRetirementReplacements,
} from "./lib/bundle-helpers.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const defaultBundleRoot = resolve(repoRoot, "opencode/arcs");
const defaultConfigRoot = resolve(homedir(), ".pi");
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

// Project deploys write into the project's own pi config dir; global deploys
// write into ~/.pi (agents/skills land under agent/, the pi agent dir).
const destination = scope === "project" ? resolve(projectRoot, ".pi") : configRoot;

const SKILL_PREFIX = "arcs-";

function isPromptPath(value) {
  if (typeof value !== "string" || value.includes("\\")) return false;
  const segments = value.split("/");
  return (
    segments.length >= 2 &&
    segments[0] === "prompts" &&
    segments.slice(1).every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
    segments.at(-1).endsWith(".txt")
  );
}

function resolveBundlePromptPath(value) {
  if (!isPromptPath(value)) throw new Error(`Invalid bundle prompt path: ${value}`);
  const promptsRoot = resolve(bundleRoot, "prompts");
  const resolvedPath = resolve(promptsRoot, ...value.split("/").slice(1));
  const relativePath = relative(promptsRoot, resolvedPath);
  if (relativePath.split(/[\\/]/).includes("..")) {
    throw new Error(`Bundle prompt path escapes prompts/: ${value}`);
  }
  return resolvedPath;
}

// ---------------------------------------------------------------------------
// Model tier configuration
// ---------------------------------------------------------------------------
// Env vars: DEPLOY_MODEL_HEAVY, DEPLOY_MODEL_STANDARD, DEPLOY_MODEL_LIGHT.
// "inherit" (the default) means the agent inherits the parent pi session's
// model — the extension default — so no `model:` frontmatter is emitted.
const tierModels = {
  heavy: process.env.DEPLOY_MODEL_HEAVY || "inherit",
  standard: process.env.DEPLOY_MODEL_STANDARD || "inherit",
  light: process.env.DEPLOY_MODEL_LIGHT || "inherit",
};

function readAgentRegistry() {
  const manifestPath = resolve(bundleRoot, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`Agent registry not found at ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  if (!Array.isArray(manifest.agents))
    throw new Error("Invalid agent registry: agents must be an array");

  const ids = new Set();
  const sources = new Set();
  const destinations = new Set();
  for (const agent of manifest.agents) {
    const valid =
      agent &&
      typeof agent.id === "string" &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agent.id) &&
      ["active", "retired"].includes(agent.status) &&
      ["primary", "subagent"].includes(agent.kind) &&
      ["heavy", "standard", "light"].includes(agent.tier) &&
      Array.isArray(agent.modes) &&
      agent.modes.length > 0 &&
      agent.modes.every((mode) => ["opencode", "claudecode", "pi"].includes(mode)) &&
      isPromptPath(agent.source) &&
      isPromptPath(agent.destination) &&
      typeof agent.description === "string" &&
      agent.description.length > 0 &&
      agent.permissions &&
      ["allow", "deny"].includes(agent.permissions.edit) &&
      ["allow", "deny"].includes(agent.permissions.bash) &&
      ["allow", "deny"].includes(agent.permissions.webfetch) &&
      ["allow", "deny"].includes(agent.permissions.mcp) &&
      ["allow", "deny"].includes(agent.permissions.task);
    if (!valid) throw new Error(`Invalid agent registry record: ${JSON.stringify(agent)}`);
    if (ids.has(agent.id)) throw new Error(`Duplicate agent registry id: ${agent.id}`);
    if (sources.has(agent.source))
      throw new Error(`Duplicate agent registry source: ${agent.source}`);
    if (destinations.has(agent.destination))
      throw new Error(`Duplicate agent registry destination: ${agent.destination}`);
    ids.add(agent.id);
    sources.add(agent.source);
    destinations.add(agent.destination);
  }
  validateRetirementReplacements(manifest.agents);
  return manifest.agents;
}

// ---------------------------------------------------------------------------
// pi destination layout
// ---------------------------------------------------------------------------

function agentConfigRelative(stem) {
  return scope === "project" ? `agents/${stem}.md` : `agent/agents/${stem}.md`;
}

function skillConfigRelative(skillName, rel) {
  const skillsRoot = scope === "project" ? "skills" : "agent/skills";
  return `${skillsRoot}/${SKILL_PREFIX}${skillName}/${rel}`;
}

function manifestConfigRelative() {
  return ".arcs-bundle.json";
}

// ---------------------------------------------------------------------------
// 1. Compile sub-agent prompts
// ---------------------------------------------------------------------------

function piTools(agent) {
  const tools = ["read", "grep", "find", "ls"];
  if (agent.permissions.edit === "allow") tools.push("write", "edit");
  if (agent.permissions.bash === "allow") tools.push("bash");
  if (agent.permissions.mcp === "allow") tools.push("ext:mcp");
  return tools.join(", ");
}

function buildAgentSources() {
  const promptsDir = resolve(bundleRoot, "prompts");
  if (!existsSync(promptsDir)) {
    throw new Error(`Prompts directory not found at ${promptsDir}`);
  }

  const registry = readAgentRegistry();
  const registeredSources = new Set(registry.map((agent) => agent.source));
  const promptFiles = readdirSync(promptsDir).filter((file) => file.endsWith(".txt"));
  for (const file of promptFiles) {
    const source = `prompts/${file}`;
    if (!registeredSources.has(source)) throw new Error(`Unregistered prompt file: ${source}`);
  }

  const sources = [];

  for (const agent of registry.filter((record) => isActiveAgentForMode(record, "pi"))) {
    const stem = agent.id;
    const sourcePath = resolveBundlePromptPath(agent.source);
    if (!existsSync(sourcePath))
      throw new Error(`Registered agent prompt not found: ${agent.source}`);
    const promptContent = readFileSync(sourcePath, "utf-8");
    const model = tierModels[agent.tier];

    const frontmatter = ["---", `name: ${stem}`, `description: ${agent.description}`];

    // "inherit" is the extension default — omit it so the agent inherits the
    // parent session's model (matches Claude Code `model: inherit`).
    if (model !== "inherit") {
      frontmatter.push(`model: ${model}`);
    }

    frontmatter.push(`tools: ${piTools(agent)}`);

    // primaries were authored with a Task tool (task: allow); on pi that is
    // ownership-scoped nested delegation.
    if (agent.permissions.task === "allow") {
      frontmatter.push("allowed_subagents: all");
    }

    const compiledContent = [...frontmatter, "---", "", promptContent].join("\n");

    sources.push({
      stem,
      compiledContent,
      configRelative: agentConfigRelative(stem),
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
        configRelative: skillConfigRelative(skillName, rel),
      });
    }
  }

  return { skillNames, files };
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

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function readInstalledManifest() {
  const manifestPath = resolve(destination, manifestConfigRelative());
  if (!existsSync(manifestPath)) return null;
  try {
    const value = JSON.parse(readFileSync(manifestPath, "utf-8"));
    return value?.bundleId === "arcs-pi-bundle" ? value : null;
  } catch {
    return null;
  }
}

function ensureParentDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const registry = readAgentRegistry();
  const previousManifest = readInstalledManifest();
  const agentSources = buildAgentSources();
  const skillSources = buildSkillSources();

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

  // Orphans
  const filesRemoved = [];

  // Skill orphans — only `arcs-*/` directories that aren't in current source.
  // The prefix gives us a safe namespace; foreign user skills are never touched.
  const skillsTargetDir = resolve(destination, scope === "project" ? "skills" : "agent/skills");
  const activeSkillDirs = new Set(skillSources.skillNames.map((n) => `${SKILL_PREFIX}${n}`));
  const orphanSkillDirs = [];
  if (existsSync(skillsTargetDir)) {
    for (const entry of readdirSync(skillsTargetDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(SKILL_PREFIX)) {
        if (!activeSkillDirs.has(entry.name)) {
          orphanSkillDirs.push(entry.name);
          filesRemoved.push(`${scope === "project" ? "skills" : "agent/skills"}/${entry.name}`);
        }
      }
    }
  }

  const retiredById = new Map(
    registry
      .filter((agent) => isRetiredAgentForMode(agent, "pi"))
      .map((agent) => [agent.id, agent]),
  );
  for (const ownership of previousManifest?.agents ?? []) {
    const retired = retiredById.get(ownership.id);
    if (!retired) continue;
    const expectedDestination = agentConfigRelative(retired.id);
    if (ownership.promptDestination !== expectedDestination) continue;
    const installedPath = resolve(destination, ownership.promptDestination);
    if (existsSync(installedPath) && sha256(readFileSync(installedPath)) === ownership.sourceHash) {
      filesRemoved.push(ownership.promptDestination);
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

    for (const fileToRemove of filesRemoved) {
      const abs = resolve(destination, fileToRemove);
      if (existsSync(abs)) {
        // Could be a file (agent orphan) or directory (skill orphan)
        const isDir = statSync(abs).isDirectory();
        rmSync(abs, { recursive: isDir, force: true });
      }
    }

    const installedManifestPath = resolve(destination, manifestConfigRelative());
    ensureParentDir(installedManifestPath);
    writeFileSync(
      installedManifestPath,
      `${JSON.stringify(
        {
          bundleId: "arcs-pi-bundle",
          installMode: `pi-${scope}`,
          sourceBundleVersion: "deploy-script",
          sourceBundleHash: sha256(readFileSync(resolve(bundleRoot, "manifest.json"))),
          installedAt: new Date().toISOString(),
          tierModels,
          ownedPaths: [],
          agents: agentSources.map((agent) => ({
            id: agent.stem,
            promptDestination: agent.configRelative,
            sourceHash: sha256(agent.compiledContent),
          })),
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
  }

  // codegraph/rtk: neither exposes a pi install target, so nothing to wire.
  const result = {
    dryRun,
    platform: "pi",
    scope,
    source: bundleRoot,
    destination,
    modelConfig: tierModels,
    filesAdded,
    filesChanged,
    filesRemoved,
    filesUnchanged,
    orphanSkillDirs,
    codegraphWired: false,
    rtkWired: false,
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
