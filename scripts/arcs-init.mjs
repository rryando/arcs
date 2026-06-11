#!/usr/bin/env node

// ARCS CLI global registration
// Usage: node scripts/arcs-init.mjs [-g] [--uninstall]
// Creates symlink ~/.local/bin/arcs → scripts/arcs-cli.mjs

import { existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync, readlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

// lstatSync-based check: works even for dangling symlinks (existsSync follows the target)
function linkExists(p) {
  try { lstatSync(p); return true; } catch { return false; }
}

function isCommandAvailable(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore", shell: true });
    return true;
  } catch {
    return false;
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, "arcs-cli.mjs");
const binDir = resolve(process.env.HOME || "~", ".local/bin");
const linkPath = resolve(binDir, "arcs");
const uninstall = process.argv.includes("--uninstall");

if (uninstall) {
  if (linkExists(linkPath)) {
    unlinkSync(linkPath);
    console.log(`Removed: ${linkPath}`);
  } else {
    console.log("Nothing to remove.");
  }
  process.exit(0);
}

// Ensure bin dir
if (!existsSync(binDir)) {
  mkdirSync(binDir, { recursive: true });
}

// Remove stale symlink if exists
if (linkExists(linkPath)) {
  const current = readlinkSync(linkPath);
  if (current === cliPath) {
    console.log(`Already registered: ${linkPath} → ${cliPath}`);
    process.exit(0);
  }
  unlinkSync(linkPath);
}

symlinkSync(cliPath, linkPath);
console.log(`Registered: ${linkPath} → ${cliPath}`);

// PATH check
const pathDirs = (process.env.PATH || "").split(":");
if (!pathDirs.includes(binDir)) {
  console.warn(`\nWARNING: ${binDir} is not in PATH.`);
  console.warn(`Add to your shell rc:  export PATH="$HOME/.local/bin:$PATH"`);
}

console.log(`\nUsage: arcs <command> [args]`);
console.log(`Commands: context, task, plan, knowledge, search, diagram, batch, validate`);

// Dependency checks
console.log("");
if (!isCommandAvailable("gh")) {
  console.warn(`WARNING: gh (GitHub CLI) not found.`);
  console.warn(`  Skills like deep-pr-review require it: https://cli.github.com/`);
}

if (!isCommandAvailable("rtk")) {
  console.warn(`WARNING: rtk not found.`);
  console.warn(`  RTK cuts agent token usage on shell commands: https://github.com/rtk-ai/rtk`);
  console.warn(`  Install: brew install rtk`);
  console.warn(`  Then wire it up: rtk init -g  (add --opencode to also wire OpenCode)`);
}
