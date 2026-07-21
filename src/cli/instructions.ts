import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { readJsonSafeSync } from "../utils/json.js";
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

/** Tier assignment for each known agent. */
const AGENT_TIER_MAP: Record<string, "heavy" | "standard" | "light"> = {
  "software-engineer": "heavy",
  "docs-researcher": "heavy",
  "arcs-docs": "heavy",
  "oncall-ops": "heavy",
  plan: "heavy",
  general: "heavy",
  build: "standard",
  "ARCS Orchestrator": "standard",
  "ARCS Caveman": "standard",
  "devil-advocate": "standard",
  "graph-explorer": "light",
  "code-reviewer": "light",
  "tech-architect": "light",
};

/**
 * Resolves the model for a given agent based on tier config and per-agent overrides.
 */
function resolveAgentModel(
  agentName: string,
  tier: "heavy" | "standard" | "light",
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
  return resolve(opencodePromptsDir(), "arcs-orchestrate.txt");
}

/** Path to the ARCS Caveman orchestrator prompt file. */
function opencodeCavemanPromptPath(): string {
  return resolve(opencodePromptsDir(), "arcs-orchestrate-caveman.txt");
}

/**
 * The OpenCode agent entry for ARCS orchestrator.
 */
export const ARCS_AGENT_ENTRY = {
  description: "ARCS - (Orchestrator)",
  mode: "primary" as const,
  prompt: "{file:./prompts/arcs-orchestrate.txt}",
  color: "#00bcd4",
};

/**
 * The OpenCode agent entry for ARCS Caveman — same capabilities as ARCS
 * Orchestrator, but with caveman speech layered on top for token efficiency.
 */
export const ARCS_CAVEMAN_AGENT_ENTRY = {
  description: "ARCS - Caveman (token-efficient orchestrator)",
  mode: "primary" as const,
  prompt: "{file:./prompts/arcs-orchestrate-caveman.txt}",
  color: "#d2691e",
};

/** The key used for the ARCS agent entry in opencode.json → agent.<key>. */
const ARCS_AGENT_KEY = "ARCS Orchestrator";

/** The key used for the ARCS Caveman agent entry. */
const ARCS_CAVEMAN_AGENT_KEY = "ARCS Caveman";

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
    // writeOpencodeAgent() always installs both the orchestrator and Caveman,
    // so existing installs auto-upgrade to gain Caveman on re-run.
    return agents != null && ARCS_AGENT_KEY in agents;
  } catch {
    return false;
  }
}

export interface AgentWriteResult {
  configPath: string;
  promptPath: string;
  cavemanPromptPath: string;
  action: "created" | "updated";
  alreadyConfigured: boolean;
}

/**
 * Registers the ARCS orchestrator agents (standard + Caveman) as primary
 * agents in opencode.json. Also writes both prompt text files to
 * ~/.config/opencode/prompts/.
 *
 * Both agents share full ARCS tool access and workflow rules; ARCS Caveman
 * layers caveman-speak on top for token-efficient chat output.
 */
export function writeOpencodeAgent(modelConfig?: ModelTierConfig): AgentWriteResult {
  const alreadyConfigured = opencodeHasAgent();
  const configFile = resolve(opencodeConfigDir(), "opencode.json");
  const promptFile = opencodePromptPath();
  const cavemanPromptFile = opencodeCavemanPromptPath();
  const existed = existsSync(configFile);

  // Write both prompt text files
  mkdirSync(opencodePromptsDir(), { recursive: true });
  writeFileSync(promptFile, `${ORCHESTRATE_PROMPT_TEXT}\n`, "utf-8");
  writeFileSync(cavemanPromptFile, `${ORCHESTRATE_CAVEMAN_PROMPT_TEXT}\n`, "utf-8");

  // Merge agent entries into opencode.json with controlled key order:
  // 1. ARCS Orchestrator (always first — controls Tab-cycle position in OpenCode)
  // 2. ARCS Caveman (second — Tab once to reach token-efficient mode)
  // 3. build (third, if already present in config)
  // 4. all other existing agents in their original order
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
    [ARCS_CAVEMAN_AGENT_KEY]: cavemanEntry,
  };
  if ("build" in existingAgents) {
    orderedAgents.build = existingAgents.build;
  }
  for (const [key, value] of Object.entries(existingAgents)) {
    if (key !== ARCS_AGENT_KEY && key !== ARCS_CAVEMAN_AGENT_KEY && key !== "build") {
      orderedAgents[key] = value;
    }
  }

  existing.agent = orderedAgents;
  // Set ARCS Orchestrator as the startup default agent (Caveman is opt-in via Tab)
  existing.default_agent = ARCS_AGENT_KEY;
  // Inject the codegraph MCP server so graph-explorer can call mcp__codegraph__*
  ensureCodegraphMcpEntry(existing);
  writeJsonFile(configFile, existing);

  return {
    configPath: configFile,
    promptPath: promptFile,
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
