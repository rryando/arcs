import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
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
import { readJsonSafeSync, stripJsonComments, validateJson } from "../utils/json.js";
import {
  opencodeInstalledManifestSchema,
  opencodeSourceManifestSchema,
  packageJsonSchema,
} from "../utils/json-schemas.js";
import { PACKAGE_ROOT } from "../utils/paths.js";

export type InstallState = "absent" | "arcs-managed" | "foreign-existing";

export interface ConfigMerge {
  path: string[];
  value: unknown;
  /**
   * "overwrite" (default): always set the value at `path`, clobbering any prior user value.
   * "if-absent":           only set the value if `path` doesn't already exist in the config.
   * "merge":               deep-merge object values — bundle adds/updates keys but never
   *                        deletes user-owned keys. Scalars within the merged object that
   *                        already exist in user config are preserved (treated as if-absent
   *                        at the leaf level). Use for agent definitions where the bundle
   *                        owns `prompt`, `description`, `permission` shape but the user
   *                        owns `model`.
   *
   * Use "if-absent" for user-preference keys that the bundle wants to seed on first install
   * but must never re-stamp on subsequent re-deploys. Concretely: provider/model routing
   * (top-level `model`, `small_model`, `agent.<name>.model`) is user-territory once chosen.
   * Re-stamping it broke OpenCode session naming for users whose actual provider differs
   * from the bundle defaults — see fix(bundle): preserve user provider/model choices.
   */
  mode?: "overwrite" | "if-absent" | "merge";
}

export interface SourceArcsBundleManifest {
  bundleId: string;
  installMode: string;
  bundleVersionSource: string;
  sourceRoot: string;
  skills: {
    source: string;
    destination: string;
  };
  agents: Array<{
    source: string;
    destination: string;
  }>;
  ownedPaths: string[];
  plugin: {
    required: boolean;
    source: string;
    destination: string;
  };
  config: {
    requiredMerges: ConfigMerge[];
  };
}

export interface InstalledArcsBundleManifest {
  bundleId: string;
  installMode: string;
  sourceBundleVersion: string;
  sourceBundleHash: string;
  installedAt: string;
  ownedPaths: string[];
}

export interface InstallDetectionResult {
  state: InstallState;
  installedManifest: InstalledArcsBundleManifest | null;
}

export interface SourceBundleInfo {
  bundleId: string;
  sourceBundleVersion: string;
  sourceBundleHash: string;
}

export interface InstallPlan {
  pathsToWrite: string[];
  pathsToRemove: string[];
  sourceBundleVersion: string;
  sourceBundleHash: string;
  requiredConfigMerges: ConfigMerge[];
}

export interface InstallOptions {
  autoConfirmReplacement?: boolean;
}

interface InstallHooks {
  afterConfigPreparedBeforeManifestWrite?: () => void;
}

export interface InstallResult {
  status: "installed";
  summary: string;
}

function readJsonFile(path: string): Record<string, unknown> {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Returns a parse-error message if the file exists on disk but is not valid
 * JSON, otherwise null (missing file, or parses cleanly). Used to refuse a
 * config-overwriting merge when the existing config is corrupt — overwriting it
 * would silently discard the user's recoverable agents/models/MCP entries.
 */
function detectConfigParseError(path: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null; // missing file is fine — a fresh config will be written
  }
  try {
    JSON.parse(stripJsonComments(raw));
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function writeJsonFile(path: string, data: object): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function deepSet(obj: Record<string, unknown>, pathParts: string[], value: unknown): void {
  let current = obj;

  for (let i = 0; i < pathParts.length - 1; i++) {
    const part = pathParts[i];
    const next = current[part];

    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      current[part] = {};
    }

    current = current[part] as Record<string, unknown>;
  }

  current[pathParts[pathParts.length - 1]] = value;
}

export function opencodeRootDir(): string {
  const envConfigDir = process.env.OPENCODE_CONFIG_DIR;
  if (envConfigDir) {
    return resolve(envConfigDir);
  }

  return resolve(process.env.HOME ?? homedir(), ".config", "opencode");
}

function sourceBundleRootDir(): string {
  return resolve(PACKAGE_ROOT, "opencode", "arcs");
}

function sourceBundlePath(relativePath: string): string {
  return resolve(sourceBundleRootDir(), relativePath);
}

function opencodePath(relativePath: string): string {
  return resolve(opencodeRootDir(), relativePath);
}

export function arcsInstalledManifestPath(): string {
  return opencodePath(".arcs-bundle.json");
}

export function opencodeConfigPath(): string {
  return opencodePath("opencode.json");
}

export function readSourceArcsBundleManifest(): SourceArcsBundleManifest {
  const manifestPath = sourceBundlePath("manifest.json");
  const raw = readJsonSafeSync<unknown>(manifestPath);
  if (raw === undefined) {
    throw new Error(`Failed to read source manifest at ${manifestPath}`);
  }
  return validateJson(raw, opencodeSourceManifestSchema, manifestPath) as SourceArcsBundleManifest;
}

export function readInstalledArcsBundleManifest(): InstalledArcsBundleManifest | null {
  const manifestPath = arcsInstalledManifestPath();
  if (!existsSync(manifestPath)) {
    return null;
  }

  const raw = readJsonSafeSync<unknown>(manifestPath);
  if (raw === undefined) return null;
  return validateJson(raw, opencodeInstalledManifestSchema, manifestPath);
}

export function writeInstalledArcsBundleManifest(manifest: InstalledArcsBundleManifest): void {
  writeJsonFile(arcsInstalledManifestPath(), manifest);
}

function resolveConfigPath(
  config: Record<string, unknown>,
  pathParts: string[],
): { found: true; value: unknown } | { found: false } {
  let current: unknown = config;

  for (const part of pathParts) {
    if (typeof current !== "object" || current === null || !(part in current)) {
      return { found: false };
    }
    current = (current as Record<string, unknown>)[part];
  }

  return { found: true, value: current };
}

function configMergeExists(config: Record<string, unknown>, merge: ConfigMerge): boolean {
  const resolved = resolveConfigPath(config, merge.path);
  return resolved.found && JSON.stringify(resolved.value) === JSON.stringify(merge.value);
}

function hasAnyExistingInstallEvidence(sourceManifest: SourceArcsBundleManifest): boolean {
  if (sourceManifest.ownedPaths.some((ownedPath) => existsSync(opencodePath(ownedPath)))) {
    return true;
  }

  if (sourceManifest.agents.some((agent) => existsSync(opencodePath(agent.destination)))) {
    return true;
  }

  if (
    sourceManifest.plugin.required &&
    existsSync(opencodePath(sourceManifest.plugin.destination))
  ) {
    return true;
  }

  const configPath = opencodeConfigPath();
  if (existsSync(configPath)) {
    const config = readJsonFile(configPath);
    return sourceManifest.config.requiredMerges.some((merge) => configMergeExists(config, merge));
  }

  return false;
}

function allOwnedPathsExist(manifest: InstalledArcsBundleManifest): boolean {
  return manifest.ownedPaths.every((ownedPath) => existsSync(opencodePath(ownedPath)));
}

export function detectArcsBundleInstall(
  sourceManifest: SourceArcsBundleManifest = readSourceArcsBundleManifest(),
): InstallDetectionResult {
  const installedManifest = readInstalledArcsBundleManifest();

  if (installedManifest) {
    const validManagedInstall =
      installedManifest.installMode === sourceManifest.installMode &&
      installedManifest.bundleId === sourceManifest.bundleId &&
      allOwnedPathsExist(installedManifest) &&
      (sourceManifest.config.requiredMerges.length === 0 ||
        hasAnyExistingInstallEvidence(sourceManifest));

    return {
      state: validManagedInstall ? "arcs-managed" : "foreign-existing",
      installedManifest,
    };
  }

  return {
    state: hasAnyExistingInstallEvidence(sourceManifest) ? "foreign-existing" : "absent",
    installedManifest: null,
  };
}

function readPackageVersion(): string {
  const pkgPath = resolve(PACKAGE_ROOT, "package.json");
  const raw = readJsonSafeSync<unknown>(pkgPath);
  if (raw === undefined) {
    throw new Error(`Failed to read ${pkgPath}`);
  }
  return validateJson(raw, packageJsonSchema, pkgPath).version;
}

function listBundleFiles(dir: string = sourceBundleRootDir()): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const absolute = resolve(dir, entry);
    const stat = statSync(absolute);

    if (stat.isDirectory()) {
      files.push(...listBundleFiles(absolute));
    } else {
      files.push(absolute);
    }
  }

  return files.sort((a, b) =>
    relative(sourceBundleRootDir(), a).localeCompare(relative(sourceBundleRootDir(), b)),
  );
}

export function getSourceArcsBundleInfo(): SourceBundleInfo {
  const manifest = readSourceArcsBundleManifest();
  const hash = createHash("sha256");

  for (const file of listBundleFiles()) {
    hash.update(relative(sourceBundleRootDir(), file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }

  return {
    bundleId: manifest.bundleId,
    sourceBundleVersion: readPackageVersion(),
    sourceBundleHash: hash.digest("hex"),
  };
}

export function buildArcsBundleInstallPlan(): InstallPlan {
  const sourceManifest = readSourceArcsBundleManifest();
  const installedManifest = readInstalledArcsBundleManifest();
  const bundleInfo = getSourceArcsBundleInfo();

  return {
    pathsToWrite: sourceManifest.ownedPaths,
    pathsToRemove:
      installedManifest == null
        ? []
        : installedManifest.ownedPaths.filter(
            (ownedPath) => !sourceManifest.ownedPaths.includes(ownedPath),
          ),
    sourceBundleVersion: bundleInfo.sourceBundleVersion,
    sourceBundleHash: bundleInfo.sourceBundleHash,
    requiredConfigMerges: sourceManifest.config.requiredMerges,
  };
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function removePathIfExists(path: string): void {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
  }
}

function _copySourceToDestination(sourceRelative: string, destinationRelative: string): void {
  const source = sourceBundlePath(sourceRelative);
  const destination = opencodePath(destinationRelative);
  const sourceStat = statSync(source);

  removePathIfExists(destination);
  ensureParent(destination);

  if (sourceStat.isDirectory()) {
    cpSync(source, destination, { recursive: true });
  } else {
    copyFileSync(source, destination);
  }
}

function createTempDir(prefix: string): string {
  const tempDir = opencodePath(`${prefix}-${Date.now().toString(36)}`);
  mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

function stageSourcePath(sourceRelative: string, stagingDir: string): string {
  const source = sourceBundlePath(sourceRelative);
  const stagedPath = resolve(stagingDir, sourceRelative);

  ensureParent(stagedPath);

  if (statSync(source).isDirectory()) {
    cpSync(source, stagedPath, { recursive: true });
  } else {
    copyFileSync(source, stagedPath);
  }

  return stagedPath;
}

function backupExistingPath(pathRelative: string, backupDir: string): string | null {
  const targetPath = opencodePath(pathRelative);
  if (!existsSync(targetPath)) {
    return null;
  }

  const backupPath = resolve(backupDir, pathRelative);
  ensureParent(backupPath);
  cpSync(targetPath, backupPath, { recursive: true });
  removePathIfExists(targetPath);
  return backupPath;
}

function restoreBackup(backupPath: string, destinationRelative: string): void {
  const destination = opencodePath(destinationRelative);
  ensureParent(destination);
  cpSync(backupPath, destination, { recursive: true });
}

function configPathExists(config: Record<string, unknown>, pathParts: string[]): boolean {
  return resolveConfigPath(config, pathParts).found;
}

/**
 * Recursively merge `source` into `target`. Existing scalar values in target
 * are preserved (user-owned). New keys from source are added. Nested objects
 * are recursively merged.
 */
function deepMergeObjects(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = target[key];

    if (
      typeof sourceVal === "object" &&
      sourceVal !== null &&
      !Array.isArray(sourceVal) &&
      typeof targetVal === "object" &&
      targetVal !== null &&
      !Array.isArray(targetVal)
    ) {
      // Both are plain objects — recurse
      target[key] = deepMergeObjects(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else if (!(key in target)) {
      // Key doesn't exist in target — add it
      target[key] = sourceVal;
    }
    // Key exists in target with a scalar/array value — preserve user's value
  }
  return target;
}

function applyConfigMerges(
  baseConfig: Record<string, unknown>,
  merges: ConfigMerge[],
): Record<string, unknown> {
  const nextConfig = JSON.parse(JSON.stringify(baseConfig)) as Record<string, unknown>;

  for (const merge of merges) {
    if (merge.mode === "if-absent" && configPathExists(nextConfig, merge.path)) {
      continue;
    }

    if (merge.mode === "merge") {
      const resolved = resolveConfigPath(nextConfig, merge.path);
      if (
        resolved.found &&
        typeof resolved.value === "object" &&
        resolved.value !== null &&
        !Array.isArray(resolved.value) &&
        typeof merge.value === "object" &&
        merge.value !== null &&
        !Array.isArray(merge.value)
      ) {
        // Deep-merge: preserve user keys, add bundle keys
        deepMergeObjects(
          resolved.value as Record<string, unknown>,
          merge.value as Record<string, unknown>,
        );
        continue;
      }
      // Path doesn't exist or isn't an object — fall through to deepSet (seed it)
    }

    deepSet(nextConfig, merge.path, merge.value);
  }

  return nextConfig;
}

function manifestFromPlan(
  plan: InstallPlan,
  sourceManifest: SourceArcsBundleManifest,
): InstalledArcsBundleManifest {
  return {
    bundleId: sourceManifest.bundleId,
    installMode: sourceManifest.installMode,
    sourceBundleVersion: plan.sourceBundleVersion,
    sourceBundleHash: plan.sourceBundleHash,
    installedAt: new Date().toISOString(),
    ownedPaths: sourceManifest.ownedPaths,
  };
}

function installInternal(options: InstallOptions = {}, hooks: InstallHooks = {}): InstallResult {
  const sourceManifest = readSourceArcsBundleManifest();
  const detection = detectArcsBundleInstall(sourceManifest);

  if (detection.state === "foreign-existing" && !options.autoConfirmReplacement) {
    throw new Error(
      "Manual confirmation is required before replacing an existing OpenCode ARCS bundle install.",
    );
  }

  mkdirSync(opencodeRootDir(), { recursive: true });

  const plan = buildArcsBundleInstallPlan();
  const stagedDir = createTempDir(".arcs-bundle-stage");
  const backupDir = createTempDir(".arcs-bundle-backup");
  const previousConfigExists = existsSync(opencodeConfigPath());
  const previousConfig = previousConfigExists ? readFileSync(opencodeConfigPath(), "utf-8") : null;

  // Refuse to proceed if an existing config is present but unparseable: the
  // merge below reads it via readJsonFile (which falls back to {} on a parse
  // error) and would then overwrite the corrupt-but-recoverable file with a
  // near-empty one, silently discarding the user's agents/models/MCP entries.
  const configParseError = detectConfigParseError(opencodeConfigPath());
  if (configParseError !== null) {
    throw new Error(
      `Existing OpenCode config at ${opencodeConfigPath()} is not valid JSON ` +
        `and would be overwritten by install:\n  ${configParseError}\n` +
        "Fix the JSON syntax error (or move the file aside) and re-run.",
    );
  }
  const previousManifest = detection.installedManifest;
  const backupMap = new Map<string, string>();

  try {
    const stagedSkills = stageSourcePath(sourceManifest.skills.source, stagedDir);
    const stagedPlugin = sourceManifest.plugin.required
      ? stageSourcePath(sourceManifest.plugin.source, stagedDir)
      : null;
    const stagedAgents = sourceManifest.agents.map((agent) => ({
      ...agent,
      stagedPath: stageSourcePath(agent.source, stagedDir),
    }));

    for (const pathToRemove of plan.pathsToRemove) {
      removePathIfExists(opencodePath(pathToRemove));
    }

    for (const ownedPath of sourceManifest.ownedPaths) {
      const backup = backupExistingPath(ownedPath, backupDir);
      if (backup) {
        backupMap.set(ownedPath, backup);
      }
    }

    removePathIfExists(opencodePath(sourceManifest.skills.destination));
    cpSync(stagedSkills, opencodePath(sourceManifest.skills.destination), { recursive: true });

    if (sourceManifest.plugin.required && stagedPlugin !== null) {
      removePathIfExists(opencodePath(sourceManifest.plugin.destination));
      ensureParent(opencodePath(sourceManifest.plugin.destination));
      copyFileSync(stagedPlugin, opencodePath(sourceManifest.plugin.destination));
    }

    for (const agent of stagedAgents) {
      removePathIfExists(opencodePath(agent.destination));
      ensureParent(opencodePath(agent.destination));
      copyFileSync(agent.stagedPath, opencodePath(agent.destination));
    }

    const preparedConfig = applyConfigMerges(
      readJsonFile(opencodeConfigPath()),
      plan.requiredConfigMerges,
    );
    hooks.afterConfigPreparedBeforeManifestWrite?.();
    writeJsonFile(opencodeConfigPath(), preparedConfig);
    writeInstalledArcsBundleManifest(manifestFromPlan(plan, sourceManifest));

    return {
      status: "installed",
      summary:
        detection.state === "arcs-managed"
          ? "Re-synced bundled ARCS skills"
          : "Installed bundled ARCS skills",
    };
  } catch (error) {
    for (const [destinationRelative, backupPath] of backupMap.entries()) {
      removePathIfExists(opencodePath(destinationRelative));
      restoreBackup(backupPath, destinationRelative);
    }

    if (previousConfig === null) {
      removePathIfExists(opencodeConfigPath());
    } else {
      ensureParent(opencodeConfigPath());
      writeFileSync(opencodeConfigPath(), previousConfig, "utf-8");
    }

    if (previousManifest == null) {
      removePathIfExists(arcsInstalledManifestPath());
    } else {
      writeInstalledArcsBundleManifest(previousManifest);
    }

    throw error;
  } finally {
    removePathIfExists(stagedDir);
    removePathIfExists(backupDir);
  }
}

export function installArcsBundle(options: InstallOptions = {}): InstallResult {
  return installInternal(options);
}

export function installArcsBundleWithHooks(
  options: InstallOptions & { hooks?: InstallHooks } = {},
): InstallResult {
  return installInternal(options, options.hooks ?? {});
}
