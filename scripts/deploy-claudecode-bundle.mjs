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
  wireCodegraphMcp,
  wireRtk,
} from "./lib/bundle-helpers.mjs";

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
// Env vars: DEPLOY_MODEL_HEAVY, DEPLOY_MODEL_STANDARD, DEPLOY_MODEL_LIGHT
// Each defaults to "inherit" if unset.
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
      agent.modes.every((mode) => ["opencode", "claudecode"].includes(mode)) &&
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

function claudeTools(agent) {
  const tools = [];
  if (agent.permissions.task === "allow") tools.push("Task");
  tools.push("Read");
  if (agent.permissions.edit === "allow") tools.push("Write", "Edit");
  tools.push("Glob", "Grep");
  if (agent.permissions.bash === "allow") tools.push("Bash");
  return tools.join(", ");
}

function ensureParentDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function readInstalledManifest() {
  const manifestPath = resolve(destination, configRelativePath(".arcs-bundle.json"));
  if (!existsSync(manifestPath)) return null;
  try {
    const value = JSON.parse(readFileSync(manifestPath, "utf-8"));
    return value?.bundleId === "arcs-claudecode-bundle" ? value : null;
  } catch {
    return null;
  }
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

  const registry = readAgentRegistry();
  const registeredSources = new Set(registry.map((agent) => agent.source));
  const promptFiles = readdirSync(promptsDir).filter((file) => file.endsWith(".txt"));
  for (const file of promptFiles) {
    const source = `prompts/${file}`;
    if (!registeredSources.has(source)) throw new Error(`Unregistered prompt file: ${source}`);
  }

  const sources = [];

  for (const agent of registry.filter((record) => isActiveAgentForMode(record, "claudecode"))) {
    const stem = agent.id;
    const sourcePath = resolveBundlePromptPath(agent.source);
    if (!existsSync(sourcePath))
      throw new Error(`Registered agent prompt not found: ${agent.source}`);
    const promptContent = readFileSync(sourcePath, "utf-8");
    const model = tierModels[agent.tier];

    // Claude Code requires `name` to be a kebab-case identifier (lowercase
    // letters + hyphens). The filename stem already satisfies this and is
    // unique, so it IS the agent name — the human-readable label lives in
    // `description`. The default-agent setting (DEFAULT_AGENT) references this
    // same stem, so it resolves. Display names with spaces/parens/apostrophes
    // (meta.name) are invalid here and caused intermittent init failures.
    const compiledContent = [
      "---",
      `name: ${stem}`,
      `description: ${agent.description}`,
      `model: ${model}`,
      `tools: ${claudeTools(agent)}`,
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
  const registry = readAgentRegistry();
  const defaultAgent =
    registry.find(
      (agent) =>
        agent.id === "arcs-orchestrate" &&
        isActiveAgentForMode(agent, "claudecode"),
    ) ??
    registry.find(
      (agent) =>
        agent.kind === "primary" && isActiveAgentForMode(agent, "claudecode"),
    );
  if (!defaultAgent) throw new Error("No active Claude Code primary agent is registered");

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

  const merged = { ...parsed, agent: defaultAgent.id };
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
  const registry = readAgentRegistry();
  const previousManifest = readInstalledManifest();
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

  const retiredById = new Map(
    registry
      .filter((agent) => isRetiredAgentForMode(agent, "claudecode"))
      .map((agent) => [agent.id, agent]),
  );
  for (const ownership of previousManifest?.agents ?? []) {
    const retired = retiredById.get(ownership.id);
    if (!retired) continue;
    const expectedDestination = configRelativePath(`agents/${retired.id}.md`);
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

    const installedManifestPath = resolve(destination, configRelativePath(".arcs-bundle.json"));
    ensureParentDir(installedManifestPath);
    writeFileSync(
      installedManifestPath,
      `${JSON.stringify(
        {
          bundleId: "arcs-claudecode-bundle",
          installMode: `claudecode-${scope}`,
          sourceBundleVersion: "deploy-script",
          sourceBundleHash: sha256(readFileSync(resolve(bundleRoot, "manifest.json"))),
          installedAt: new Date().toISOString(),
          // Persisted so a later `arcs init` can reuse the previous tier
          // selection instead of re-prompting for it.
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
