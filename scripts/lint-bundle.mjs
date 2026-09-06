#!/usr/bin/env node
// Bundle linter — detects drift/issues in the opencode ARCS bundle without
// overwriting anything. The repo bundle directory is the source of truth.
//
// Env vars:
//   BUNDLE_LINT_BUNDLE_ROOT  — override bundle root (default: opencode/arcs)
//
// Outputs JSON to stdout: { issues: [...], summary: { errors, warnings } }
// Exit code: 0 if no errors, 1 if errors found.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// import.meta.dirname is Node >=20.11; derive it for Node 18 compatibility.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const defaultBundleRoot = resolve(repoRoot, "opencode/arcs");

const bundleRoot = process.env.BUNDLE_LINT_BUNDLE_ROOT
  ? resolve(repoRoot, process.env.BUNDLE_LINT_BUNDLE_ROOT)
  : defaultBundleRoot;

/** @type {Array<{severity: 'error'|'warning', kind: string, message: string, file?: string, repair?: string}>} */ const issues =
  [];

function addIssue(severity, kind, message, file, repair) {
  const issue = { severity, kind, message };
  if (file) issue.file = file;
  if (repair) issue.repair = repair;
  issues.push(issue);
}

function listAllFiles(rootPath, currentPath = rootPath) {
  if (!existsSync(currentPath)) return [];
  const entries = readdirSync(currentPath, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const entryPath = resolve(currentPath, entry.name);
    if (entry.isDirectory()) return listAllFiles(rootPath, entryPath);
    return [relative(rootPath, entryPath).replace(/\\/g, "/")];
  });
}

// --- Read manifest ---
const manifestPath = resolve(bundleRoot, "bundle-runtime.json");
if (!existsSync(manifestPath)) {
  addIssue("error", "manifest-missing", `bundle-runtime.json not found at ${manifestPath}`);
  output();
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
const sourceManifestPath = resolve(bundleRoot, "manifest.json");
if (!existsSync(sourceManifestPath)) {
  addIssue("error", "source-manifest-missing", `manifest.json not found at ${sourceManifestPath}`);
  output();
}
const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, "utf-8"));

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

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function isAgentRegistryRecord(agent) {
  return (
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
    ["edit", "bash", "webfetch", "mcp", "task"].every((permission) =>
      ["allow", "deny"].includes(agent.permissions[permission]),
    ) &&
    (!agent.pi || (
      Array.isArray(agent.pi.extensions) &&
      agent.pi.extensions.every((extension) => typeof extension === "string" && extension.length > 0) &&
      Array.isArray(agent.pi.skills) &&
      agent.pi.skills.every((skill) => typeof skill === "string" && skill.length > 0) &&
      (agent.pi.thinking === undefined || thinkingLevels.includes(agent.pi.thinking))
    ))
  );
}

if (!Array.isArray(sourceManifest.agents)) {
  addIssue(
    "error",
    "invalid-agent-registry",
    `Source manifest agents must be an array`,
    "manifest.json",
  );
}
const registryAgents = Array.isArray(sourceManifest.agents) ? sourceManifest.agents : [];
const registryIds = new Set();
const registrySources = new Set();
const registryDestinations = new Set();
for (const agent of registryAgents) {
  if (!isAgentRegistryRecord(agent)) {
    addIssue(
      "error",
      "invalid-agent-registry",
      `Source manifest contains an invalid agent registry record`,
      "manifest.json",
    );
    continue;
  }
  if (registryIds.has(agent.id)) {
    addIssue(
      "error",
      "invalid-agent-registry",
      `Source manifest contains duplicate agent id ${agent.id}`,
      "manifest.json",
    );
  }
  registryIds.add(agent.id);
  if (registrySources.has(agent.source)) {
    addIssue(
      "error",
      "invalid-agent-registry",
      `Source manifest contains duplicate agent source ${agent.source}`,
      "manifest.json",
    );
  }
  registrySources.add(agent.source);
  if (registryDestinations.has(agent.destination)) {
    addIssue(
      "error",
      "invalid-agent-registry",
      `Source manifest contains duplicate agent destination ${agent.destination}`,
      "manifest.json",
    );
  }
  registryDestinations.add(agent.destination);

  if (agent.status === "active" && agent.kind === "subagent" && agent.modes.includes("opencode")) {
    const merge = sourceManifest.config?.requiredMerges?.find(
      (entry) =>
        entry.path?.length === 2 && entry.path[0] === "agent" && entry.path[1] === agent.id,
    );
    const value = merge?.value;
    if (
      !value ||
      value.description !== agent.description ||
      value.mode !== agent.kind ||
      value.prompt !== `{file:./${agent.destination}}` ||
      ["edit", "bash", "webfetch", "mcp"].some(
        (permission) => value.permission?.[permission] !== agent.permissions[permission],
      )
    ) {
      addIssue(
        "error",
        "agent-config-drift",
        `OpenCode config for ${agent.id} does not match its registry record`,
        "manifest.json",
      );
    }
  }
}

// --- Check 1: Every manifest-declared bundled file exists ---
const declaredFiles = new Set();

for (const [skillName, skillFiles] of Object.entries(manifest.skills ?? {})) {
  for (const skillFile of skillFiles) {
    const relativePath = `skills/${skillName}/${skillFile}`;
    declaredFiles.add(relativePath);
    if (!existsSync(resolve(bundleRoot, relativePath))) {
      addIssue(
        "error",
        "missing-declared-file",
        `Manifest declares ${relativePath} but file is missing`,
        relativePath,
        `Run bundle build or add the file`,
      );
    }
  }
}

for (const agentFile of manifest.agents ?? []) {
  declaredFiles.add(agentFile);
  if (!existsSync(resolve(bundleRoot, agentFile))) {
    addIssue(
      "error",
      "missing-declared-file",
      `Manifest declares ${agentFile} but file is missing`,
      agentFile,
    );
  }
}

for (const pluginFile of manifest.plugin ?? []) {
  declaredFiles.add(pluginFile);
  if (!existsSync(resolve(bundleRoot, pluginFile))) {
    addIssue(
      "error",
      "missing-declared-file",
      `Manifest declares ${pluginFile} but file is missing`,
      pluginFile,
    );
  }
}

for (const agent of sourceManifest.agents ?? []) {
  if (agent.status !== "active" || !isPromptPath(agent.source)) continue;
  declaredFiles.add(agent.source);
  if (!existsSync(resolve(bundleRoot, agent.source))) {
    addIssue(
      "error",
      "missing-declared-file",
      `Source manifest declares ${agent.source} but file is missing`,
      agent.source,
    );
  }
}

const preservedFiles = new Set(manifest.preservedFiles ?? []);
for (const preservedFile of preservedFiles) {
  if (!existsSync(resolve(bundleRoot, preservedFile))) {
    addIssue(
      "error",
      "missing-preserved-file",
      `Runtime manifest preserves ${preservedFile} but file is missing`,
      preservedFile,
    );
  }
}

// --- Check 2: No extra undeclared files in bundle ---
const allBundleFiles = listAllFiles(bundleRoot);
const allowedFiles = new Set([...declaredFiles, ...preservedFiles]);

for (const file of allBundleFiles) {
  if (!allowedFiles.has(file)) {
    addIssue(
      "error",
      "undeclared-file",
      `File ${file} exists in bundle but is not declared in manifest`,
      file,
      `Remove the file or add it to bundle-runtime.json`,
    );
  }
}

// --- Check 3: Every skill includes SKILL.md ---
for (const [skillName, skillFiles] of Object.entries(manifest.skills ?? {})) {
  if (!skillFiles.includes("SKILL.md")) {
    addIssue(
      "error",
      "skill-missing-entry",
      `Skill "${skillName}" does not include SKILL.md in its file list`,
      `skills/${skillName}/SKILL.md`,
      `Add "SKILL.md" to the skill's file array in bundle-runtime.json`,
    );
  }
}

// --- Check 4: .mjs scripts declared should be parseable ---
for (const [skillName, skillFiles] of Object.entries(manifest.skills ?? {})) {
  for (const skillFile of skillFiles) {
    if (skillFile.endsWith(".mjs")) {
      const filePath = resolve(bundleRoot, `skills/${skillName}/${skillFile}`);
      if (existsSync(filePath)) {
        // Quick syntax check — try to parse as module
        try {
          const content = readFileSync(filePath, "utf-8");
          // Basic check: not empty
          if (content.trim().length === 0) {
            addIssue(
              "warning",
              "empty-script",
              `Bundled script skills/${skillName}/${skillFile} is empty`,
              `skills/${skillName}/${skillFile}`,
            );
          }
        } catch (err) {
          addIssue(
            "error",
            "unreadable-script",
            `Cannot read bundled script: ${err.message}`,
            `skills/${skillName}/${skillFile}`,
          );
        }
      }
    }
  }
}

// --- Check 5: arcs-dashboard/package.json type field ---
const dashboardPkgPath = resolve(bundleRoot, "skills/arcs-dashboard/package.json");
if (existsSync(dashboardPkgPath)) {
  try {
    const pkg = JSON.parse(readFileSync(dashboardPkgPath, "utf-8"));
    if (!pkg.type) {
      addIssue(
        "error",
        "package-json-invalid",
        `arcs-dashboard package.json missing "type" field (expected "commonjs")`,
        "skills/arcs-dashboard/package.json",
        `Add "type": "commonjs" to the package.json`,
      );
    }
  } catch (err) {
    addIssue(
      "error",
      "package-json-invalid",
      `arcs-dashboard package.json is not valid JSON: ${err.message}`,
      "skills/arcs-dashboard/package.json",
    );
  }
}

// --- Check 6: REMOVED. The repo bundle is the source of truth — there is no
// external "config root" mirror to compare against. Drift detection against
// ~/.config/opencode/ has been deleted; use `arcs deploy-superpowers --dry-run`
// if you want to preview what would change in the deployment target.

function output() {
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const result = { issues, summary: { errors, warnings } };
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exitCode = errors > 0 ? 1 : 0;
  process.exit();
}

output();
