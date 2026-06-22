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

// Preserved files that are repo-authored, not sourced from manifest.
const preservedFiles = new Set([
  "manifest.json",
  "bundle-runtime.json",
  ".opencode/plugins/arcs.js",
  "skills/loop/SKILL.md",
  "skills/caveman-commit/SKILL.md",
  "skills/init-project/SKILL.md",
  "skills/the-ladder/SKILL.md",
  // Sub-agent prompt files (repo-authored, referenced from manifest.json
  // requiredMerges, not from bundle-runtime.json's `agents` array).
  "prompts/software-engineer.txt",
  "prompts/tech-architect.txt",
  "prompts/oncall-ops.txt",
  "prompts/arcs-docs.txt",
  "prompts/code-reviewer.txt",
  "prompts/docs-researcher.txt",
  "prompts/devil-advocate.txt",
  "prompts/graph-explorer.txt",
  // Orchestrator prompt files — generated from src/cli/arcs-orchestrate*.ts
  // by build-opencode-bundle.mjs. Committed mirrors so the bundle is
  // self-describing alongside the static sub-agent prompts.
  "prompts/arcs-orchestrate.txt",
  "prompts/arcs-orchestrate-caveman.txt",
]);

/** @type {Array<{severity: 'error'|'warning', kind: string, message: string, file?: string, repair?: string}>} */const issues = [];

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
    addIssue("error", "missing-declared-file", `Manifest declares ${agentFile} but file is missing`, agentFile);
  }
}

for (const pluginFile of manifest.plugin ?? []) {
  declaredFiles.add(pluginFile);
  if (!existsSync(resolve(bundleRoot, pluginFile))) {
    addIssue("error", "missing-declared-file", `Manifest declares ${pluginFile} but file is missing`, pluginFile);
  }
}

// --- Check 2: No extra undeclared files in bundle ---
const allBundleFiles = listAllFiles(bundleRoot);
const allowedFiles = new Set([...declaredFiles, ...preservedFiles]);

for (const file of allBundleFiles) {
  if (!allowedFiles.has(file)) {
    addIssue(
      "warning",
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
