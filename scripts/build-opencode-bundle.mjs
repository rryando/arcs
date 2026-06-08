import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  normalizeRelativePath,
  listDeclaredFiles,
  validateDeclaredPath,
} from "./lib/bundle-helpers.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const defaultManifestPath = resolve(repoRoot, "opencode/arcs/bundle-runtime.json");
const defaultOutputRoot = resolve(repoRoot, "opencode/arcs");
// Files that are repo-authored and must not be pruned. The repo bundle
// directory IS the source of truth — there is no external mirror.
const preservedOutputFiles = new Set([
  "manifest.json",
  "bundle-runtime.json",
  ".opencode/plugins/arcs.js",
  // ARCS-native skills (authored in this repo, no upstream source)
  // init-project skill — ARCS-native (mirrors orchestrator INIT workflow with
  // graphify sub-flow, typed-agent dispatch, knowledge categories).
  "skills/init-project/SKILL.md",
  // Caveman commit skill — adapted from https://github.com/JuliusBrussee/caveman (MIT).
  "skills/caveman-commit/SKILL.md",
  // Agent prompt files (repo-authored, referenced via {file:} in manifest.json)
  "prompts/software-engineer.txt",
  "prompts/tech-architect.txt",
  "prompts/qa-analyst.txt",
  "prompts/oncall-ops.txt",
  "prompts/arcs-docs.txt",
  "prompts/system-architect.txt",
  "prompts/code-reviewer.txt",
  "prompts/docs-researcher.txt",
  "prompts/devil-advocate.txt",
  "prompts/graph-explorer.txt",
  // Orchestrator prompt files — generated from src/cli/arcs-orchestrate*.ts during
  // bundle build (see generateOrchestratorPrompts() below). TS modules remain the
  // canonical source; these .txt files are committed mirrors so the bundle is
  // self-describing and all prompts live in one directory.
  "prompts/arcs-orchestrate.txt",
  "prompts/arcs-orchestrate-caveman.txt",
]);

function ensureParentDirectory(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function pruneUndeclaredFiles(rootPath, allowedFiles) {
  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    const entryPath = resolve(rootPath, entry.name);

    if (entry.isDirectory()) {
      pruneUndeclaredFiles(entryPath, allowedFiles);

      if (readdirSync(entryPath).length === 0) {
        rmSync(entryPath, { recursive: true, force: true });
      }

      continue;
    }

    const relativePath = normalizeRelativePath(relative(defaultOutputRootCurrent, entryPath));
    if (!allowedFiles.has(relativePath)) {
      rmSync(entryPath, { force: true });
    }
  }
}

let defaultOutputRootCurrent = defaultOutputRoot;

/**
 * Generates the ARCS Orchestrator and ARCS Caveman prompt .txt files into
 * <outputRoot>/prompts/. The TypeScript modules src/cli/arcs-orchestrate.ts
 * and src/cli/arcs-orchestrate-caveman.ts remain the canonical source; these
 * .txt files are committed mirrors so the bundle is self-describing alongside
 * the static sub-agent prompts.
 *
 * Requires `tsc` to have run first (dist/cli/arcs-orchestrate.js must exist).
 * package.json's build:opencode-bundle chains `tsc` before this script.
 */
async function generateOrchestratorPrompts(outputRoot) {
  const orchestrateModulePath = resolve(repoRoot, "dist/cli/arcs-orchestrate.js");
  const cavemanModulePath = resolve(repoRoot, "dist/cli/arcs-orchestrate-caveman.js");

  if (!existsSync(orchestrateModulePath) || !existsSync(cavemanModulePath)) {
    throw new Error(
      `Compiled orchestrator modules missing. Run \`npm run build\` before bundle build.\n` +
        `  Expected: ${orchestrateModulePath}\n` +
        `  Expected: ${cavemanModulePath}`,    );
  }

  const orchestrateModule = await import(pathToFileURL(orchestrateModulePath).href);
  const cavemanModule = await import(pathToFileURL(cavemanModulePath).href);

  const orchestrateText = orchestrateModule.ORCHESTRATE_PROMPT_TEXT;
  const cavemanText = cavemanModule.ORCHESTRATE_CAVEMAN_PROMPT_TEXT;

  if (typeof orchestrateText !== "string" || orchestrateText.length === 0) {
    throw new Error("ORCHESTRATE_PROMPT_TEXT not exported as non-empty string");
  }
  if (typeof cavemanText !== "string" || cavemanText.length === 0) {
    throw new Error("ORCHESTRATE_CAVEMAN_PROMPT_TEXT not exported as non-empty string");
  }

  const promptsDir = resolve(outputRoot, "prompts");
  mkdirSync(promptsDir, { recursive: true });

  const orchestratePath = resolve(promptsDir, "arcs-orchestrate.txt");
  const cavemanPath = resolve(promptsDir, "arcs-orchestrate-caveman.txt");

  // Banner prepended to every generated prompt file. Uses HTML comment syntax
  // so it's invisible when rendered as markdown but obvious to anyone opening
  // the .txt directly. LLMs treat HTML comments as out-of-band metadata, so
  // the banner does not pollute the prompt's actionable instructions.
  const banner = (sourceFile) =>
    `<!--\n` +
    `  AUTO-GENERATED — DO NOT EDIT.\n` +
    `  Source of truth: ${sourceFile}\n` +
    `  Regenerate: npm run build:opencode-bundle\n` +
    `  Edits to this file will be overwritten on the next build.\n` +
    `-->\n\n`;

  writeFileSync(
    orchestratePath,
    `${banner("src/cli/arcs-orchestrate.ts")}${orchestrateText}\n`,
    "utf-8",
  );
  writeFileSync(
    cavemanPath,
    `${banner("src/cli/arcs-orchestrate-caveman.ts")}${cavemanText}\n`,
    "utf-8",
  );
}

async function main() {
  const manifestPath = process.env.ARCS_BUNDLE_RUNTIME_MANIFEST
    ? resolve(repoRoot, process.env.ARCS_BUNDLE_RUNTIME_MANIFEST)
    : defaultManifestPath;
  const runtimeManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const outputRoot = process.env.ARCS_BUNDLE_OUTPUT_ROOT
    ? resolve(repoRoot, process.env.ARCS_BUNDLE_OUTPUT_ROOT)
    : defaultOutputRoot;

  const declaredFiles = listDeclaredFiles(runtimeManifest);
  const allowedOutputFiles = new Set([
    ...declaredFiles.map((entry) => entry.declaredPath),
    ...preservedOutputFiles,
  ]);

  defaultOutputRootCurrent = outputRoot;

  // Validate that every manifest-declared file already exists in the bundle.
  // The bundle directory IS the source of truth — files are authored here,
  // not copied from anywhere external.
  for (const { declaredPath, validationRoot } of declaredFiles) {
    const relativePath = validateDeclaredPath(declaredPath, outputRoot, validationRoot);
    const outputPath = resolve(outputRoot, relativePath);
    if (!existsSync(outputPath)) {
      throw new Error(`Missing declared bundle file: ${relativePath} (${outputPath})`);
    }
    ensureParentDirectory(outputPath);
  }

  mkdirSync(outputRoot, { recursive: true });
  pruneUndeclaredFiles(outputRoot, allowedOutputFiles);

  // Generate orchestrator prompt mirrors after prune so they always end up
  // on disk fresh from the canonical TS sources.
  await generateOrchestratorPrompts(outputRoot);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
