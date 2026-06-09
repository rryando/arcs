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
import { wireCodegraphMcp } from "./lib/bundle-helpers.mjs";

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

async function main() {
  const manifestPath = resolve(bundleRoot, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest.json not found at ${manifestPath}`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

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
  if (manifest.plugin && manifest.plugin.source) {
    const pluginSource = resolve(bundleRoot, manifest.plugin.source);
    if (existsSync(pluginSource)) {
      deployMap.set(manifest.plugin.destination, pluginSource);
    }
  }

  // Agents (sub-agent prompts) — bundle prompts/<file> → config prompts/<file>
  for (const agent of manifest.agents ?? []) {
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
    const isChanged =
      !isNew && readFileSync(configAbsolute, "utf-8") !== sourceContent;

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
    ...(restartRequired && {
      restartGuidance: "Plugin file changed. Restart opencode for changes to take effect.",
    }),
  };

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
