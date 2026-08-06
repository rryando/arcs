import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { readJsonSafeSync } from "../utils/json.js";
import { type AgentTier, getActiveAgent, getAgentTierMap } from "./agent-registry.js";
import { FLASH_PROMPT_TEXT } from "./arcs-flash.js";
import { ORCHESTRATE_PROMPT_TEXT } from "./arcs-orchestrate.js";
import { ORCHESTRATE_CAVEMAN_PROMPT_TEXT } from "./arcs-orchestrate-caveman.js";
import type { ModelTierConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safely parse a JSON file. Returns empty object on any error. */
function readJsonFile(path: string): Record<string, unknown> {
  return readJsonSafeSync<Record<string, unknown>>(path) ?? {};
}

/** Write JSON content to disk, creating parent dirs as needed. */
function writeJsonFile(path: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

/**
 * Deep-set a nested key path on an object (mutates in place).
 * E.g. deepSet(obj, ["agent", "ARCS Orchestrator"], value)
 */
function _deepSet(obj: Record<string, unknown>, keys: string[], value: unknown): void {
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (typeof current[k] !== "object" || current[k] === null || Array.isArray(current[k])) {
      current[k] = {};
    }
    current = current[k] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

/**
 * Ensure the codegraph MCP server entry exists in an opencode config (mutates
 * in place). Idempotent: only sets/overwrites the `codegraph` key under `mcp`,
 * preserving any sibling MCP entries the user may have configured.
 */
function ensureCodegraphMcpEntry(config: Record<string, unknown>): void {
  const mcp =
    typeof config.mcp === "object" && config.mcp !== null && !Array.isArray(config.mcp)
      ? (config.mcp as Record<string, unknown>)
      : {};
  mcp.codegraph = { type: "local", command: ["codegraph", "serve", "--mcp"], enabled: true };
  config.mcp = mcp;
}

// ---------------------------------------------------------------------------
// Agent Model Resolution
// ---------------------------------------------------------------------------

/** OpenCode host agents are not owned by the ARCS registry. */
const HOST_AGENT_TIER_MAP: Record<string, AgentTier> = {
  plan: "heavy",
  general: "heavy",
  build: "standard",
};

const registryAgentTiers = getAgentTierMap();
const AGENT_TIER_MAP: Record<string, AgentTier> = {
  ...registryAgentTiers,
  ...HOST_AGENT_TIER_MAP,
  "ARCS Orchestrator": registryAgentTiers["arcs-orchestrate"],
  "ARCS Flash": registryAgentTiers["arcs-flash"],
  "ARCS Caveman": registryAgentTiers["arcs-orchestrate-caveman"],
};

/**
 * Resolves the model for a given agent based on tier config and per-agent overrides.
 */
function resolveAgentModel(
  agentName: string,
  tier: AgentTier,
  modelConfig: ModelTierConfig,
): string {
  return modelConfig.perAgent?.[agentName] ?? modelConfig[tier];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Formats a short summary of an IDE config path for display.
 * Replaces $HOME with ~ for readability.
 */
export function displayPath(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

// ---------------------------------------------------------------------------
// OpenCode Agent Registration
// ---------------------------------------------------------------------------

/** Path to the OpenCode config directory. */
function opencodeConfigDir(): string {
  return resolve(homedir(), ".config", "opencode");
}

/** Path to the OpenCode prompts directory. */
function opencodePromptsDir(): string {
  return resolve(opencodeConfigDir(), "prompts");
}

/** Path to the ARCS orchestrator prompt file. */
function opencodePromptPath(): string {
  return resolve(opencodeConfigDir(), getActiveAgent("arcs-orchestrate").destination);
}

/** Path to the ARCS Flash orchestrator prompt file. */
function opencodeFlashPromptPath(): string {
  return resolve(opencodeConfigDir(), getActiveAgent("arcs-flash").destination);
}

/** Path to the ARCS Caveman orchestrator prompt file. */
function opencodeCavemanPromptPath(): string {
  return resolve(opencodeConfigDir(), getActiveAgent("arcs-orchestrate-caveman").destination);
}

const orchestratorAgent = getActiveAgent("arcs-orchestrate");
const flashAgent = getActiveAgent("arcs-flash");
const cavemanAgent = getActiveAgent("arcs-orchestrate-caveman");

/**
 * The OpenCode agent entry for ARCS orchestrator.
 */
export const ARCS_AGENT_ENTRY = {
  description: orchestratorAgent.description,
  mode: orchestratorAgent.kind,
  prompt: `{file:./${orchestratorAgent.destination}}`,
  color: "#00bcd4",
};

/**
 * The OpenCode agent entry for ARCS Flash — same authority and safety
 * invariants as ARCS Orchestrator, with a knowledge-first, parallel-first
 * control flow under tiered gates.
 */
export const ARCS_FLASH_AGENT_ENTRY = {
  description: flashAgent.description,
  mode: flashAgent.kind,
  prompt: `{file:./${flashAgent.destination}}`,
  color: "#ffc107",
};

/**
 * The OpenCode agent entry for ARCS Caveman — same capabilities as ARCS
 * Orchestrator, but with caveman speech layered on top for token efficiency.
 */
export const ARCS_CAVEMAN_AGENT_ENTRY = {
  description: cavemanAgent.description,
  mode: cavemanAgent.kind,
  prompt: `{file:./${cavemanAgent.destination}}`,
  color: "#d2691e",
};

/** The key used for the ARCS agent entry in opencode.json → agent.<key>. */
const ARCS_AGENT_KEY = "ARCS Orchestrator";

/** The key used for the ARCS Flash agent entry. */
const ARCS_FLASH_AGENT_KEY = "ARCS Flash";

/** The key used for the ARCS Caveman agent entry. */
const ARCS_CAVEMAN_AGENT_KEY = "ARCS Caveman";

/**
 * Maps a registry agent id (as picked in the setup wizard) to its opencode.json
 * agent key. Only used to choose which primary opencode starts on — all three
 * primaries are registered regardless of the pick.
 */
const PRIMARY_AGENT_KEY_BY_ID: Record<string, string> = {
  "arcs-orchestrate": ARCS_AGENT_KEY,
  "arcs-flash": ARCS_FLASH_AGENT_KEY,
  "arcs-orchestrate-caveman": ARCS_CAVEMAN_AGENT_KEY,
};

/**
 * Reverse of {@link PRIMARY_AGENT_KEY_BY_ID} — maps an opencode.json
 * `default_agent` key back to the registry id the setup wizard picks from.
 */
const PRIMARY_AGENT_ID_BY_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(PRIMARY_AGENT_KEY_BY_ID).map(([id, key]) => [key, id]),
);

/**
 * Checks whether the ARCS agent is already registered in opencode.json.
 */
export function opencodeHasAgent(): boolean {
  const configFile = resolve(opencodeConfigDir(), "opencode.json");
  if (!existsSync(configFile)) return false;
  try {
    const config = readJsonSafeSync<Record<string, unknown>>(configFile) ?? {};
    const agents = config.agent as Record<string, unknown> | undefined;
    // Presence gate: if the orchestrator is registered, ARCS is "configured".
    // writeOpencodeAgent() always installs the orchestrator, Flash, and Caveman,
    // so existing installs auto-upgrade to gain Flash and Caveman on re-run.
    return agents != null && ARCS_AGENT_KEY in agents;
  } catch {
    return false;
  }
}

/**
 * Returns the registry id of the ARCS primary currently set as opencode's
 * `default_agent`, or undefined when it is unset, unreadable, or names an agent
 * outside the three ARCS primaries.
 *
 * Callers pre-select the wizard's primary prompt with it so re-running setup and
 * pressing Enter preserves the existing default instead of resetting it.
 */
export function readOpencodePrimaryAgentId(): string | undefined {
  const configFile = resolve(opencodeConfigDir(), "opencode.json");
  if (!existsSync(configFile)) return undefined;
  const key = readJsonFile(configFile).default_agent;
  return typeof key === "string" ? PRIMARY_AGENT_ID_BY_KEY[key] : undefined;
}

export interface AgentWriteResult {
  configPath: string;
  promptPath: string;
  flashPromptPath: string;
  cavemanPromptPath: string;
  action: "created" | "updated";
  alreadyConfigured: boolean;
}

/**
 * Registers the ARCS orchestrator agents (standard + Flash + Caveman) as
 * primary agents in opencode.json. Also writes all three prompt text files to
 * ~/.config/opencode/prompts/.
 *
 * All three agents share full ARCS tool access and workflow rules; ARCS Flash
 * runs a knowledge-first, parallel-first control flow, and ARCS Caveman layers
 * caveman-speak on top for token-efficient chat output.
 *
 * `primaryAgentId` picks which of the three opencode starts on. Omitting it (or
 * passing an unknown id) keeps the historical default, ARCS Orchestrator.
 */
export function writeOpencodeAgent(
  modelConfig?: ModelTierConfig,
  primaryAgentId?: string,
): AgentWriteResult {
  const alreadyConfigured = opencodeHasAgent();
  const configFile = resolve(opencodeConfigDir(), "opencode.json");
  const promptFile = opencodePromptPath();
  const flashPromptFile = opencodeFlashPromptPath();
  const cavemanPromptFile = opencodeCavemanPromptPath();
  const existed = existsSync(configFile);

  // Write all three prompt text files
  mkdirSync(opencodePromptsDir(), { recursive: true });
  writeFileSync(promptFile, `${ORCHESTRATE_PROMPT_TEXT}\n`, "utf-8");
  writeFileSync(flashPromptFile, `${FLASH_PROMPT_TEXT}\n`, "utf-8");
  writeFileSync(cavemanPromptFile, `${ORCHESTRATE_CAVEMAN_PROMPT_TEXT}\n`, "utf-8");

  // Merge agent entries into opencode.json with controlled key order:
  // 1. ARCS Orchestrator (always first — controls Tab-cycle position in OpenCode)
  // 2. ARCS Flash (second — Tab once to reach the speed-optimized orchestrator)
  // 3. ARCS Caveman (third — Tab twice to reach token-efficient mode)
  // 4. build (fourth, if already present in config)
  // 5. all other existing agents in their original order
  const existing = readJsonFile(configFile);
  const existingAgents = (existing.agent ?? {}) as Record<string, unknown>;

  // Primary agents get a model field resolved from tier map (standard) unless
  // the user provided a perAgent override, which always wins.
  const orchestratorEntry: Record<string, unknown> = { ...ARCS_AGENT_ENTRY };
  if (modelConfig) {
    orchestratorEntry.model = resolveAgentModel(
      ARCS_AGENT_KEY,
      AGENT_TIER_MAP[ARCS_AGENT_KEY] ?? "standard",
      modelConfig,
    );
  }

  const flashEntry: Record<string, unknown> = { ...ARCS_FLASH_AGENT_ENTRY };
  if (modelConfig) {
    flashEntry.model = resolveAgentModel(
      ARCS_FLASH_AGENT_KEY,
      AGENT_TIER_MAP[ARCS_FLASH_AGENT_KEY] ?? "standard",
      modelConfig,
    );
  }

  const cavemanEntry: Record<string, unknown> = { ...ARCS_CAVEMAN_AGENT_ENTRY };
  if (modelConfig) {
    cavemanEntry.model = resolveAgentModel(
      ARCS_CAVEMAN_AGENT_KEY,
      AGENT_TIER_MAP[ARCS_CAVEMAN_AGENT_KEY] ?? "standard",
      modelConfig,
    );
  }

  const orderedAgents: Record<string, unknown> = {
    [ARCS_AGENT_KEY]: orchestratorEntry,
    [ARCS_FLASH_AGENT_KEY]: flashEntry,
    [ARCS_CAVEMAN_AGENT_KEY]: cavemanEntry,
  };
  if ("build" in existingAgents) {
    orderedAgents.build = existingAgents.build;
  }
  for (const [key, value] of Object.entries(existingAgents)) {
    if (!Object.hasOwn(orderedAgents, key) && key !== "build") {
      orderedAgents[key] = value;
    }
  }

  existing.agent = orderedAgents;
  // Set the startup default agent from the caller's pick; the other two stay
  // registered and remain opt-in via Tab. Key order above is unaffected.
  existing.default_agent =
    (primaryAgentId ? PRIMARY_AGENT_KEY_BY_ID[primaryAgentId] : undefined) ?? ARCS_AGENT_KEY;
  // Inject the codegraph MCP server so graph-explorer can call mcp__codegraph__*
  ensureCodegraphMcpEntry(existing);
  writeJsonFile(configFile, existing);

  return {
    configPath: configFile,
    promptPath: promptFile,
    flashPromptPath: flashPromptFile,
    cavemanPromptPath: cavemanPromptFile,
    action: existed ? "updated" : "created",
    alreadyConfigured,
  };
}

// ---------------------------------------------------------------------------
// Apply Model Config to All Agents
// ---------------------------------------------------------------------------

/**
 * Applies ModelTierConfig to all known agent entries in opencode.json.
 * Each agent (primary or sub-agent) listed in AGENT_TIER_MAP gets a `model`
 * field resolved from its tier. perAgent overrides always win.
 * Call this AFTER bundle install so it overwrites hardcoded manifest models.
 */
export function applyAgentModelConfig(modelConfig: ModelTierConfig): void {
  const configFile = resolve(opencodeConfigDir(), "opencode.json");
  if (!existsSync(configFile)) return;

  const config = readJsonFile(configFile);

  // Set top-level model routing from tier picks
  config.model = modelConfig.standard || modelConfig.heavy;
  config.small_model = modelConfig.light;

  const agents = config.agent as Record<string, Record<string, unknown>> | undefined;
  if (agents) {
    for (const [name, entry] of Object.entries(agents)) {
      if (typeof entry !== "object" || entry === null) continue;

      const tier = AGENT_TIER_MAP[name];
      if (tier) {
        entry.model = resolveAgentModel(name, tier, modelConfig);
      }
    }

    config.agent = agents;
  }

  writeJsonFile(configFile, config);
}
