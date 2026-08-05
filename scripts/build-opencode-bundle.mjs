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
 * Generates the ARCS Orchestrator, ARCS Caveman, and ARCS Flash prompt .txt
 * files into <outputRoot>/prompts/. The TypeScript modules
 * src/cli/arcs-orchestrate.ts, src/cli/arcs-orchestrate-caveman.ts, and
 * src/cli/arcs-flash.ts remain the canonical source; these .txt files are
 * committed mirrors so the bundle is self-describing alongside the static
 * sub-agent prompts.
 *
 * Requires `tsc` to have run first (dist/cli/arcs-orchestrate.js must exist).
 * package.json's build:opencode-bundle chains `tsc` before this script.
 */
async function generateOrchestratorPrompts(outputRoot) {
  const orchestrateModulePath = resolve(repoRoot, "dist/cli/arcs-orchestrate.js");
  const cavemanModulePath = resolve(repoRoot, "dist/cli/arcs-orchestrate-caveman.js");
  const flashModulePath = resolve(repoRoot, "dist/cli/arcs-flash.js");

  if (
    !existsSync(orchestrateModulePath) ||
    !existsSync(cavemanModulePath) ||
    !existsSync(flashModulePath)
  ) {
    throw new Error(
      `Compiled orchestrator modules missing. Run \`npm run build\` before bundle build.\n` +
        `  Expected: ${orchestrateModulePath}\n` +
        `  Expected: ${cavemanModulePath}\n` +
        `  Expected: ${flashModulePath}`,
    );
  }

  const orchestrateModule = await import(pathToFileURL(orchestrateModulePath).href);
  const cavemanModule = await import(pathToFileURL(cavemanModulePath).href);
  const flashModule = await import(pathToFileURL(flashModulePath).href);

  const orchestrateText = orchestrateModule.ORCHESTRATE_PROMPT_TEXT;
  const cavemanText = cavemanModule.ORCHESTRATE_CAVEMAN_PROMPT_TEXT;
  const flashText = flashModule.FLASH_PROMPT_TEXT;

  if (typeof orchestrateText !== "string" || orchestrateText.length === 0) {
    throw new Error("ORCHESTRATE_PROMPT_TEXT not exported as non-empty string");
  }
  if (typeof cavemanText !== "string" || cavemanText.length === 0) {
    throw new Error("ORCHESTRATE_CAVEMAN_PROMPT_TEXT not exported as non-empty string");
  }
  if (typeof flashText !== "string" || flashText.length === 0) {
    throw new Error("FLASH_PROMPT_TEXT not exported as non-empty string");
  }

  const promptsDir = resolve(outputRoot, "prompts");
  mkdirSync(promptsDir, { recursive: true });

  const orchestratePath = resolve(promptsDir, "arcs-orchestrate.txt");
  const cavemanPath = resolve(promptsDir, "arcs-orchestrate-caveman.txt");
  const flashPath = resolve(promptsDir, "arcs-flash.txt");

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
  writeFileSync(flashPath, `${banner("src/cli/arcs-flash.ts")}${flashText}\n`, "utf-8");
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

  const sourceManifestPath = resolve(outputRoot, "manifest.json");
  const sourceManifest = existsSync(sourceManifestPath)
    ? JSON.parse(readFileSync(sourceManifestPath, "utf-8"))
    : { agents: [] };
  const allowedOutputFiles = new Set([
    ...declaredFiles.map((entry) => entry.declaredPath),
    ...(runtimeManifest.preservedFiles ?? []),
    ...(sourceManifest.agents ?? []).map((agent) => agent.source),
  ]);

  mkdirSync(outputRoot, { recursive: true });
  await generateOrchestratorPrompts(outputRoot);
  pruneUndeclaredFiles(outputRoot, allowedOutputFiles);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
