import { accessSync, constants, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readJsonSafeSync, stripJsonComments } from "../utils/json.js";
import { cliConfigSchema } from "../utils/json-schemas.js";
import { ensureDataDir, getDataDir } from "../utils/paths.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface ArcsConfig {
  version: "1";
  ides: string[];
  opencodeModelVariants?: ModelVariants;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export function defaultConfig(): ArcsConfig {
  return {
    version: "1",
    ides: [],
  };
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

function configPath(): string {
  return resolve(getDataDir(), "config.json");
}

/**
 * Returns true if ~/.arcs/config.json exists.
 */
export function configExists(): boolean {
  try {
    accessSync(configPath(), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads config from disk. Returns default config if file missing.
 */
export function readConfig(): ArcsConfig {
  const raw = readJsonSafeSync<unknown>(configPath());
  if (raw === undefined) return defaultConfig();
  const result = cliConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    console.error(`Invalid config at ${configPath()}:\n${issues}`);
    process.exit(1);
  }
  return result.data;
}

/**
 * Reads config for setup flows. Invalid persisted config is discarded so init/config can
 * recover by writing a fresh valid config after the user completes setup.
 */
export function readConfigOrDefault(): ArcsConfig {
  const raw = readJsonSafeSync<unknown>(configPath());
  if (raw === undefined) return defaultConfig();
  const result = cliConfigSchema.safeParse(raw);
  return result.success ? result.data : defaultConfig();
}

/**
 * Writes config to disk. Ensures data dir exists first.
 */
export function writeConfig(config: ArcsConfig): void {
  ensureDataDir();
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

// ---------------------------------------------------------------------------
// OpenCode Model Config
// ---------------------------------------------------------------------------

export type ModelTierConfig = {
  heavy: string;
  standard: string;
  light: string;
  /** OpenCode model-scoped variants applied to every agent in the tier. */
  variants?: ModelVariants;
  perAgent?: Record<string, string>;
};

export type ModelVariants = {
  heavy: string;
  standard: string;
  light: string;
};

/** Default OpenCode variant: no additional thinking. */
export const DEFAULT_MODEL_VARIANT = "none";

/**
 * Reads ~/.config/opencode/opencode.json. Returns parsed JSON or null on failure.
 */
export async function readOpenCodeConfig(): Promise<unknown | null> {
  try {
    const filePath = join(homedir(), ".config", "opencode", "opencode.json");
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(stripJsonComments(content));
  } catch {
    return null;
  }
}

/**
 * Diagnoses the opencode config file state, distinguishing a genuinely absent
 * config (where manual model entry is the right fallback) from one that exists
 * on disk but fails to parse (corruption — which must be surfaced, not silently
 * treated as "no config"). The plain {@link readOpenCodeConfig} collapses both
 * cases to `null`, which previously let a corrupt config masquerade as missing.
 */
export async function diagnoseOpenCodeConfig(): Promise<
  | { status: "missing"; path: string }
  | { status: "ok"; path: string; config: unknown }
  | { status: "corrupt"; path: string; error: string }
> {
  const path = join(homedir(), ".config", "opencode", "opencode.json");
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return { status: "missing", path };
  }
  try {
    return { status: "ok", path, config: JSON.parse(stripJsonComments(content)) };
  } catch (err) {
    return { status: "corrupt", path, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Diagnoses the installed Claude Code bundle manifest (~/.claude/.arcs-bundle.json),
 * written by scripts/deploy-claudecode-bundle.mjs on every deploy, and reads back the
 * `tierModels` it persisted so a later `arcs init` can reuse the previous selection
 * instead of re-prompting.
 *
 * Mirrors {@link diagnoseOpenCodeConfig}'s three-state shape, with two deliberate
 * distinctions:
 * - A parseable file that is not an ARCS Claude Code bundle manifest (wrong `bundleId`
 *   or no installed agents) is "missing", not "corrupt" — it is a foreign/unrelated
 *   file, not damage.
 * - A valid manifest whose heavy/standard/light `tierModels` are absent or incomplete is
 *   "ok" WITHOUT `tierModels` (e.g. a bundle deployed before this field existed). Only
 *   the three Claude Code model tiers are persisted.
 */
export async function diagnoseClaudeCodeBundle(): Promise<
  | { status: "missing"; path: string }
  | { status: "ok"; path: string; tierModels?: ModelTierConfig }
  | { status: "corrupt"; path: string; error: string }
> {
  const path = join(homedir(), ".claude", ".arcs-bundle.json");
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return { status: "missing", path };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return { status: "corrupt", path, error: err instanceof Error ? err.message : String(err) };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "missing", path };
  }
  const manifest = parsed as Record<string, unknown>;
  if (manifest.bundleId !== "arcs-claudecode-bundle") return { status: "missing", path };
  if (!Array.isArray(manifest.agents) || manifest.agents.length === 0) {
    return { status: "missing", path };
  }

  const tiers = manifest.tierModels;
  if (tiers === null || typeof tiers !== "object" || Array.isArray(tiers)) {
    return { status: "ok", path };
  }
  const { heavy, standard, light } = tiers as Record<string, unknown>;
  if (
    typeof heavy !== "string" ||
    typeof standard !== "string" ||
    typeof light !== "string" ||
    !heavy ||
    !standard ||
    !light
  ) {
    return { status: "ok", path };
  }
  return { status: "ok", path, tierModels: { heavy, standard, light } };
}

/**
 * Diagnosis for the pi deploy bundle manifest (~/.pi/.arcs-bundle.json),
 * mirroring {@link diagnoseClaudeCodeBundle} for the pi host. Reads the
 * `tierModels` the pi deploy script persisted so a later `arcs init` can
 * reuse the previous selection instead of re-prompting.
 */
export async function diagnosePiBundle(): Promise<
  | { status: "missing"; path: string }
  | { status: "ok"; path: string; tierModels?: ModelTierConfig }
  | { status: "corrupt"; path: string; error: string }
> {
  const path = join(homedir(), ".pi", ".arcs-bundle.json");
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return { status: "missing", path };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return { status: "corrupt", path, error: err instanceof Error ? err.message : String(err) };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "missing", path };
  }
  const manifest = parsed as Record<string, unknown>;
  if (manifest.bundleId !== "arcs-pi-bundle") return { status: "missing", path };
  if (!Array.isArray(manifest.agents) || manifest.agents.length === 0) {
    return { status: "missing", path };
  }

  const tiers = manifest.tierModels;
  if (tiers === null || typeof tiers !== "object" || Array.isArray(tiers)) {
    return { status: "ok", path };
  }
  const { heavy, standard, light } = tiers as Record<string, unknown>;
  if (
    typeof heavy !== "string" ||
    typeof standard !== "string" ||
    typeof light !== "string" ||
    !heavy ||
    !standard ||
    !light
  ) {
    return { status: "ok", path };
  }
  return { status: "ok", path, tierModels: { heavy, standard, light } };
}

/**
 * Extracts model tier pre-fills from parsed opencode config.
 */
export function extractModelPreFills(config: unknown): ModelTierConfig {
  if (config === null || config === undefined || typeof config !== "object") {
    return { heavy: "", standard: "", light: "" };
  }
  const obj = config as Record<string, unknown>;
  const model = typeof obj.model === "string" ? obj.model : "";
  const smallModel = typeof obj.small_model === "string" ? obj.small_model : "";
  const result: ModelTierConfig = {
    heavy: model,
    standard: model,
    light: smallModel || model,
  };
  return result;
}

// ---------------------------------------------------------------------------
// Model Discovery
// ---------------------------------------------------------------------------

export interface ProviderModels {
  provider: string;
  models: string[];
}

// ---------------------------------------------------------------------------
// Claude Code model list
// ---------------------------------------------------------------------------

/**
 * Curated list of Claude models supported by Claude Code.
 *
 * Aliases only — pinned version identifiers (`claude-opus-4-7`, …) are
 * deliberately absent so a deployed bundle tracks whatever the alias resolves
 * to instead of freezing on a snapshot that ages out. `fable` is a heavy-class
 * model offered in the list but not wired as any tier default.
 *
 * `inherit` is not a model but the pseudo-value Claude Code agent frontmatter
 * accepts to defer to the host session's model — the same value
 * scripts/deploy-claudecode-bundle.mjs falls back to when a tier is unset. It is
 * listed explicitly because the tier note already tells users to reach for it,
 * and requiring them to discover it behind "Enter custom model ID" made a
 * documented choice effectively unreachable.
 */
const CLAUDE_CODE_MODELS: ProviderModels[] = [
  {
    provider: "claude (aliases)",
    models: ["opus", "sonnet", "haiku", "fable", "inherit"],
  },
];

/**
 * Reads ~/.claude/settings.json and returns the currently configured model
 * (or empty string if unset / file missing).
 */
export async function readClaudeCodeCurrentModel(): Promise<string> {
  try {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    const content = await readFile(settingsPath, "utf-8");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return typeof parsed.model === "string" ? parsed.model : "";
  } catch {
    return "";
  }
}

/**
 * Reads ~/.claude/settings.json and returns the registry id of the primary
 * agent the last deploy made the default (or empty string if unset / file
 * missing). scripts/deploy-claudecode-bundle.mjs writes this key on every
 * deploy, so a re-run of the wizard can pre-select what is actually installed
 * instead of silently resetting the default back to the built-in fallback.
 */
export async function readClaudeCodeCurrentPrimaryAgent(): Promise<string> {
  try {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    const content = await readFile(settingsPath, "utf-8");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return typeof parsed.agent === "string" ? parsed.agent : "";
  } catch {
    return "";
  }
}

/**
 * Returns the curated Claude Code model list.
 *
 * The list is a single alias group, so there is nothing to order by the
 * currently configured model — the "current" model only drives the per-tier
 * pre-fill at the prompt, not the shape of this list.
 */
export function getClaudeCodeModels(): ProviderModels[] {
  return CLAUDE_CODE_MODELS;
}

/**
 * Reads ~/.local/share/opencode/auth.json to get authenticated provider names,
 * then runs `opencode models <provider>` for each to get available models.
 * Returns array sorted with providers matching currentModel first.
 */
export async function getAvailableModels(currentModel: string): Promise<ProviderModels[]> {
  const { execSync } = await import("node:child_process");
  let authData: Record<string, unknown> = {};

  try {
    const authPath = join(homedir(), ".local", "share", "opencode", "auth.json");
    const content = await readFile(authPath, "utf-8");
    authData = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return [];
  }

  const providerNames = Object.keys(authData).filter(
    (k) => authData[k] !== null && authData[k] !== undefined,
  );

  const results: ProviderModels[] = [];

  for (const provider of providerNames) {
    try {
      const output = execSync(`opencode models ${provider}`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 15_000,
      }).trim();
      const models = output
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (models.length > 0) {
        results.push({ provider, models });
      }
    } catch {
      // Provider models command failed, skip
    }
  }

  // Sort: providers matching currentModel first
  const currentProvider = currentModel.split("/")[0] || "";
  results.sort((a, b) => {
    const aMatch = a.provider === currentProvider ? 0 : 1;
    const bMatch = b.provider === currentProvider ? 0 : 1;
    return aMatch - bMatch;
  });

  return results;
}
