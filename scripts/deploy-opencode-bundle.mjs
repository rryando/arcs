#!/usr/bin/env node

// Deploy opencode ARCS bundle bundle from repo to user config.
//
// Direction: repo → config ONLY. Never writes config → repo.
//
// Env vars:
//   DEPLOY_BUNDLE_ROOT  — override bundle root (default: opencode/arcs)
//   DEPLOY_CONFIG_ROOT  — override config root (default: ~/.config/opencode)
//   DEPLOY_DRY_RUN      — "false" to actually copy; anything else = dry-run (default: dry-run)
//
// Outputs JSON to stdout: DeployResult
// Exit code: 0 on success, 1 on error.

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoReservedPathSegments,
  assertPathWithinCategoryRoot,
  isActiveAgentForMode,
  isRetiredAgentForMode,
  validateRetirementReplacements,
  wireCodegraphMcp,
  wireRtk,
} from "./lib/bundle-helpers.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const defaultBundleRoot = resolve(repoRoot, "opencode/arcs");
const defaultConfigRoot = resolve(homedir(), ".config/opencode");

const bundleRoot = process.env.DEPLOY_BUNDLE_ROOT
  ? resolve(repoRoot, process.env.DEPLOY_BUNDLE_ROOT)
  : defaultBundleRoot;
const configRoot = process.env.DEPLOY_CONFIG_ROOT
  ? resolve(repoRoot, process.env.DEPLOY_CONFIG_ROOT)
  : defaultConfigRoot;
// Dry-run by default. Only DEPLOY_DRY_RUN=false (exact string) triggers real writes.
const dryRun = process.env.DEPLOY_DRY_RUN !== "false";

function listAllFiles(rootPath, currentPath = rootPath) {
  if (!existsSync(currentPath)) return [];
  const entries = readdirSync(currentPath, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const entryPath = resolve(currentPath, entry.name);
    if (entry.isDirectory()) return listAllFiles(rootPath, entryPath);
    return [relative(rootPath, entryPath).replace(/\\/g, "/")];
  });
}

function ensureParentDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function readInstalledManifest() {
  const path = resolve(configRoot, ".arcs-bundle.json");
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf-8"));
    return value?.bundleId === "arcs-opencode-bundle" ? value : null;
  } catch {
    return null;
  }
}

function configOwnershipHash(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return sha256(JSON.stringify(value));
  }
  const withoutModel = { ...value };
  delete withoutModel.model;
  return sha256(JSON.stringify(withoutModel));
}

function agentDefaultModel(manifest, id) {
  const merge = (manifest.config?.requiredMerges ?? []).find(
    (candidate) =>
      candidate.path?.length === 2 &&
      candidate.path[0] === "agent" &&
      candidate.path[1] === id &&
      candidate.value &&
      typeof candidate.value === "object",
  );
  return merge?.value?.model;
}

function validateManifestPaths(manifest) {
  assertPathWithinCategoryRoot(manifest.skills.source, "skills");
  assertPathWithinCategoryRoot(manifest.skills.destination, "skills");

  for (const ownedPath of manifest.ownedPaths ?? []) {
    assertNoReservedPathSegments(ownedPath);
  }

  if (manifest.plugin?.source) {
    assertPathWithinCategoryRoot(manifest.plugin.source, ".opencode/plugins");
    assertPathWithinCategoryRoot(manifest.plugin.destination, "plugins");
  }

  for (const agent of manifest.agents ?? []) {
    assertPathWithinCategoryRoot(agent.source, "prompts");
    assertPathWithinCategoryRoot(agent.destination, "prompts");
  }
}

function validateAgentRegistry(agents) {
  if (!Array.isArray(agents)) throw new Error("Invalid agent registry: agents must be an array");
  const byId = new Map();
  const sources = new Set();
  const destinations = new Set();
  for (const agent of agents ?? []) {
    if (!agent || typeof agent.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agent.id)) {
      throw new Error("Invalid agent registry: every agent requires a valid id");
    }
    if (agent.status !== "active" && agent.status !== "retired") {
      throw new Error(`Invalid agent registry status for ${agent.id}`);
    }
    if (agent.kind !== "primary" && agent.kind !== "subagent") {
      throw new Error(`Invalid agent registry kind for ${agent.id}`);
    }
    if (
      !Array.isArray(agent.modes) ||
      agent.modes.length === 0 ||
      agent.modes.some((mode) => mode !== "opencode" && mode !== "claudecode" && mode !== "pi")
    ) {
      throw new Error(`Invalid agent registry modes for ${agent.id}`);
    }
    if (byId.has(agent.id)) throw new Error(`Invalid agent registry: duplicate id ${agent.id}`);
    if (sources.has(agent.source)) {
      throw new Error(`Invalid agent registry: duplicate source ${agent.source}`);
    }
    if (destinations.has(agent.destination)) {
      throw new Error(`Invalid agent registry: duplicate destination ${agent.destination}`);
    }
    byId.set(agent.id, agent);
    sources.add(agent.source);
    destinations.add(agent.destination);
  }

  validateRetirementReplacements(agents);
}

async function main() {
  const manifestPath = resolve(bundleRoot, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest.json not found at ${manifestPath}`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  validateManifestPaths(manifest);
  validateAgentRegistry(manifest.agents);
  const previousManifest = readInstalledManifest();

  // Build mapping: config-relative path → bundle-absolute path
  const deployMap = new Map();

  // Skills: bundle skills/<name>/<file> → config skills/arcs/<name>/<file>
  const skillsSourceDir = resolve(bundleRoot, manifest.skills.source);
  if (existsSync(skillsSourceDir)) {
    const skillFiles = listAllFiles(skillsSourceDir);
    for (const file of skillFiles) {
      const configRelative = `${manifest.skills.destination}/${file}`;
      const bundleAbsolute = resolve(skillsSourceDir, file);
      deployMap.set(configRelative, bundleAbsolute);
    }
  }

  // Plugin
  if (manifest.plugin?.source) {
    const pluginSource = resolve(bundleRoot, manifest.plugin.source);
    if (existsSync(pluginSource)) {
      deployMap.set(manifest.plugin.destination, pluginSource);
    }
  }

  // Agents (sub-agent prompts) — bundle prompts/<file> → config prompts/<file>
  for (const agent of (manifest.agents ?? []).filter((record) =>
    isActiveAgentForMode(record, "opencode"),
  )) {
    const agentSource = resolve(bundleRoot, agent.source);
    if (existsSync(agentSource)) {
      deployMap.set(agent.destination, agentSource);
    }
  }

  // Pass 1: Determine file states (detection only — no writes yet)
  const filesAdded = [];
  const filesChanged = [];
  const filesUnchanged = [];
  let restartRequired = false;

  for (const [configRelative, bundleAbsolute] of deployMap) {
    const configAbsolute = resolve(configRoot, configRelative);
    const sourceContent = readFileSync(bundleAbsolute, "utf-8");

    const isNew = !existsSync(configAbsolute);
    const isChanged = !isNew && readFileSync(configAbsolute, "utf-8") !== sourceContent;

    if (isNew) {
      filesAdded.push(configRelative);
    } else if (isChanged) {
      filesChanged.push(configRelative);
    } else {
      filesUnchanged.push(configRelative);
    }

    // Plugin change/add → restart required
    if (configRelative === manifest.plugin?.destination && (isNew || isChanged)) {
      restartRequired = true;
    }
  }

  // Detect files to remove: files in owned paths in config that are NOT in deployMap
  const filesRemoved = [];
  for (const ownedPath of manifest.ownedPaths ?? []) {
    const ownedAbsolute = resolve(configRoot, ownedPath);
    if (!existsSync(ownedAbsolute)) continue;

    // Owned path may be a file or directory
    if (!lstatSync(ownedAbsolute).isDirectory()) {
      if (!deployMap.has(ownedPath)) {
        filesRemoved.push(ownedPath);
      }
      continue;
    }

    const existingFiles = listAllFiles(ownedAbsolute);
    for (const file of existingFiles) {
      const configRelative = `${ownedPath}/${file}`;
      if (!deployMap.has(configRelative)) {
        filesRemoved.push(configRelative);
      }
    }
  }

  const retiredById = new Map(
    (manifest.agents ?? [])
      .filter((agent) => isRetiredAgentForMode(agent, "opencode"))
      .map((agent) => [agent.id, agent]),
  );
  let config = null;
  let configChanged = false;
  const configPath = resolve(configRoot, "opencode.json");
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      config = null;
    }
  }
  const configAgents =
    config?.agent && typeof config.agent === "object" && !Array.isArray(config.agent)
      ? config.agent
      : null;

  for (const ownership of previousManifest?.agents ?? []) {
    const retired = retiredById.get(ownership.id);
    if (!retired || retired.destination !== ownership.promptDestination) continue;
    const promptPath = resolve(configRoot, ownership.promptDestination);
    if (existsSync(promptPath) && sha256(readFileSync(promptPath)) === ownership.sourceHash) {
      filesRemoved.push(ownership.promptDestination);
    }

    if (!configAgents || !ownership.configKey || !ownership.configHash) continue;
    const current = configAgents[ownership.configKey];
    if (current === undefined || configOwnershipHash(current) !== ownership.configHash) continue;
    const replacement = retired.replacementId ? configAgents[retired.replacementId] : null;
    const retiredDefault = agentDefaultModel(manifest, ownership.id);
    if (
      replacement &&
      typeof replacement === "object" &&
      current?.model !== undefined &&
      current.model !== retiredDefault
    ) {
      const replacementDefault = agentDefaultModel(manifest, retired.replacementId);
      if (replacement.model === undefined || replacement.model === replacementDefault) {
        replacement.model = current.model;
      }
    }
    delete configAgents[ownership.configKey];
    configChanged = true;
  }

  // Pass 2: Apply writes (only when not dry-run)
  if (!dryRun) {
    // Clean-delete the skills directory before copying to guarantee a fresh install.
    // Prevents residual files from renamed/removed skills surviving across deploys.
    const skillsDest = resolve(configRoot, manifest.skills.destination);
    if (existsSync(skillsDest)) {
      rmSync(skillsDest, { recursive: true, force: true });
    }

    // Write all files from deployMap (recreates skills dir + copies plugin + agents)
    for (const [configRelative, bundleAbsolute] of deployMap) {
      const configAbsolute = resolve(configRoot, configRelative);
      ensureParentDir(configAbsolute);
      copyFileSync(bundleAbsolute, configAbsolute);
    }

    // Remove orphans from other owned paths (skills dir already cleared above; force: true
    // makes this a no-op for any skills paths that were already wiped)
    for (const fileToRemove of filesRemoved) {
      rmSync(resolve(configRoot, fileToRemove), { force: true });
    }

    if (configChanged) {
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
    }

    const activeAgents = (manifest.agents ?? []).filter((agent) =>
      isActiveAgentForMode(agent, "opencode"),
    );
    const previousAgents = new Map(
      (previousManifest?.agents ?? []).map((ownership) => [ownership.id, ownership]),
    );
    const installedAgents = activeAgents
      .filter((agent) => deployMap.has(agent.destination))
      .map((agent) => {
        const previous = previousAgents.get(agent.id);
        const currentConfig = configAgents?.[agent.id];
        const configStillOwned =
          previous?.configKey &&
          previous?.configHash &&
          currentConfig !== undefined &&
          configOwnershipHash(currentConfig) === previous.configHash;
        return {
          id: agent.id,
          promptDestination: agent.destination,
          sourceHash: sha256(readFileSync(resolve(configRoot, agent.destination))),
          ...(configStillOwned
            ? { configKey: previous.configKey, configHash: previous.configHash }
            : {}),
        };
      });
    writeFileSync(
      resolve(configRoot, ".arcs-bundle.json"),
      `${JSON.stringify(
        {
          bundleId: manifest.bundleId,
          installMode: manifest.installMode,
          sourceBundleVersion: "deploy-script",
          sourceBundleHash: sha256(readFileSync(manifestPath)),
          installedAt: new Date().toISOString(),
          ownedPaths: manifest.ownedPaths ?? [],
          agents: installedAgents,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
  }

  // After successful deploy, ensure arcs CLI is globally registered
  if (!dryRun) {
    try {
      const { execFileSync } = await import("node:child_process");
      const initScript = resolve(repoRoot, "scripts/arcs-init.mjs");
      if (existsSync(initScript)) {
        execFileSync(process.execPath, [initScript], { stdio: "pipe" });
      }
    } catch {
      // Non-fatal: CLI registration is a convenience, not a requirement
    }
  }

  // Best-effort: wire the codegraph MCP server. Skipped on dry-run; never fatal.
  const codegraphWired = dryRun ? false : wireCodegraphMcp("opencode");

  // Best-effort: wire RTK instructions + hook. Skipped on dry-run; never fatal.
  const rtkWired = dryRun ? false : wireRtk("opencode");

  const result = {
    dryRun,
    source: bundleRoot,
    destination: configRoot,
    filesAdded,
    filesChanged,
    filesRemoved,
    filesUnchanged,
    restartRequired,
    cliRegistered: !dryRun,
    codegraphWired,
    rtkWired,
    ...(restartRequired && {
      restartGuidance: "Plugin file changed. Restart opencode for changes to take effect.",
    }),
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
