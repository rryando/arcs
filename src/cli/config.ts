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
  perAgent?: Record<string, string>;
};

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
 * - A valid manifest whose `tierModels` is absent or incomplete is "ok" WITHOUT
 *   `tierModels` (e.g. a bundle deployed before this field existed). Tier read-back is
 *   strictly all-or-nothing: a partial substitution could silently mis-tier agents on
 *   the next deploy, so a half-known selection is reported as no selection at all.
 */
export async function diagnoseClaudeCodeBundle(): Promise<
  | { status: "missing"; path: string }
  | { status: "ok"; path: string; tierModels?: { heavy: string; standard: string; light: string } }
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
 * Extracts model tier pre-fills from parsed opencode config.
 */
export function extractModelPreFills(config: unknown): ModelTierConfig {
  if (config === null || config === undefined || typeof config !== "object") {
    return { heavy: "", standard: "", light: "" };
  }
  const obj = config as Record<string, unknown>;
  const model = typeof obj.model === "string" ? obj.model : "";
  const smallModel = typeof obj.small_model === "string" ? obj.small_model : "";
  return {
    heavy: model,
    standard: model,
    light: smallModel || model,
  };
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
 * Curated list of Claude models supported by Claude Code, grouped by family.
 * Derived from the Claude Code binary (latest-first within each family).
 * Aliases (opus/sonnet/haiku) are listed first as shortcuts.
 */
const CLAUDE_CODE_MODELS: ProviderModels[] = [
  {
    provider: "claude (aliases)",
    models: ["opus", "sonnet", "haiku"],
  },
  {
    provider: "claude-opus",
    models: [
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-opus-4-1",
      "claude-opus-4-0",
    ],
  },
  {
    provider: "claude-sonnet",
    models: ["claude-sonnet-4-6", "claude-sonnet-4-5", "claude-sonnet-4-0", "claude-sonnet-3-7"],
  },
  {
    provider: "claude-haiku",
    models: ["claude-haiku-4-5", "claude-haiku-3-5"],
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
 * Returns the curated Claude Code model list, sorted so the family matching
 * `currentModel` appears first.
 */
export function getClaudeCodeModels(currentModel: string): ProviderModels[] {
  const family = currentModel.includes("opus")
    ? "claude-opus"
    : currentModel.includes("sonnet")
      ? "claude-sonnet"
      : currentModel.includes("haiku")
        ? "claude-haiku"
        : "";

  if (!family) return CLAUDE_CODE_MODELS;

  return [
    ...CLAUDE_CODE_MODELS.filter((g) => g.provider === family),
    ...CLAUDE_CODE_MODELS.filter((g) => g.provider !== family),
  ];
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
