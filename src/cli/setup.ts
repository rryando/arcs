import { execSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import color from "picocolors";
import { detectCodegraph } from "../utils/codegraph.js";
import { PACKAGE_ROOT } from "../utils/paths.js";
import { detectRtk } from "../utils/rtk.js";
import { type AgentTier, getActiveAgents, getAgentsByTier } from "./agent-registry.js";
import { detectArcsBundleInstall, installArcsBundle } from "./bundle-installer.js";
import {
  type ArcsConfig,
  DEFAULT_MODEL_VARIANT,
  diagnoseClaudeCodeBundle,
  diagnoseOpenCodeConfig,
  extractModelPreFills,
  getAvailableModels,
  getClaudeCodeModels,
  type ModelTierConfig,
  type ModelVariants,
  type ProviderModels,
  readClaudeCodeCurrentModel,
  readClaudeCodeCurrentPrimaryAgent,
  readConfigOrDefault,
  writeConfig,
} from "./config.js";
import {
  applyAgentModelConfig,
  displayPath,
  opencodeHasAgent,
  readOpencodePrimaryAgentId,
  writeOpencodeAgent,
} from "./instructions.js";

const HOST_AGENT_TIERS: Array<{ name: string; tier: AgentTier }> = [
  { name: "plan", tier: "heavy" },
  { name: "general", tier: "heavy" },
  { name: "build", tier: "standard" },
];

function tierAgentNames(tier: AgentTier): string {
  return [
    ...getAgentsByTier()[tier].map((agent) => agent.id),
    ...HOST_AGENT_TIERS.filter((agent) => agent.tier === tier).map((agent) => agent.name),
  ].join(", ");
}

function registryTierAgentNames(tier: AgentTier): string {
  return getAgentsByTier()
    [tier].map((agent) => agent.id)
    .join(", ");
}

// ---------------------------------------------------------------------------
// Primary Orchestrator Selection
// ---------------------------------------------------------------------------

/** Registry id of the primary the wizard defaults to (today's behavior). */
const DEFAULT_PRIMARY_AGENT_ID = "arcs-orchestrate";

/** The three ARCS primaries, in Tab-cycle order. All stay registered. */
const PRIMARY_AGENT_OPTIONS: Array<{ value: string; label: string; hint: string }> = [
  {
    value: "arcs-orchestrate",
    label: "ARCS Orchestrator",
    hint: "Full gated pipeline. Maximum rigor, sequential phase gates.",
  },
  {
    value: "arcs-flash",
    label: "ARCS Flash",
    hint: "Speed-optimized. Parallel dispatch, tiered gates, knowledge-first.",
  },
  {
    value: "arcs-orchestrate-caveman",
    label: "ARCS Caveman",
    hint: "Terse. Minimal commentary, same gates.",
  },
];

/**
 * Asks which ARCS primary should be the startup default for one runtime.
 * Every primary is installed either way — only the default changes — and each
 * runtime is asked separately so OpenCode and Claude Code can differ.
 *
 * `currentPrimaryId` is the runtime's *installed* default. It pre-selects the
 * prompt so re-running the wizard and pressing Enter preserves the existing
 * choice; hard-coding the built-in default here would silently reset a user who
 * had switched away from it. An absent or unrecognized value (unset, hand-edited
 * to a non-ARCS agent, first run) falls back to the built-in default.
 */
async function selectPrimaryAgent(runtime: string, currentPrimaryId?: string): Promise<string> {
  const initialValue =
    currentPrimaryId && PRIMARY_AGENT_OPTIONS.some((option) => option.value === currentPrimaryId)
      ? currentPrimaryId
      : DEFAULT_PRIMARY_AGENT_ID;

  const selected = await p.select({
    message: `Which ARCS primary should be the default in ${runtime}?`,
    options: PRIMARY_AGENT_OPTIONS,
    initialValue,
  });

  if (p.isCancel(selected)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  return selected as string;
}

// ---------------------------------------------------------------------------
// TUI Wizard
// ---------------------------------------------------------------------------

/**
 * Reads the ARCS package version from package.json.
 * Returns an empty string if it cannot be read.
 */
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf-8")) as {
      version: string;
    };
    return pkg.version;
  } catch {
    return "";
  }
}

/**
 * Runs the interactive setup wizard.
 * @param mode "init" for first-time setup, "config" for reconfiguration.
 */
export async function runSetup(mode: "init" | "config"): Promise<void> {
  // ── Environment detection gates ─────────────────────────────────────────────
  let hasOpenCode = false;
  let hasClaudeCode = false;

  try {
    execSync("which opencode", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    hasOpenCode = true;
  } catch {
    // ignore
  }

  try {
    execSync("which claude", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    hasClaudeCode = true;
  } catch {
    // ignore
  }

  if (!hasOpenCode && !hasClaudeCode) {
    p.cancel(
      "Neither OpenCode nor Claude Code is installed or on PATH. ARCS requires at least one of them.",
    );
    process.exit(1);
  }

  const isInit = mode === "init";

  console.clear();
  const version = readVersion();
  const versionSuffix = version ? ` v${version} ` : " ";
  p.intro(
    color.bgCyan(
      color.black(isInit ? ` ARCS setup ${versionSuffix}` : ` ARCS config ${versionSuffix}`),
    ),
  );

  let selectedPlatforms: string[] = [];

  if (hasOpenCode && hasClaudeCode) {
    const selected = await p.multiselect({
      message: "Which IDE platforms would you like to configure ARCS with?",
      options: [
        { value: "opencode", label: "OpenCode" },
        { value: "claudecode", label: "Claude Code" },
      ],
    });

    if (p.isCancel(selected)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }
    selectedPlatforms = selected as string[];
  } else if (hasOpenCode) {
    const confirmOpenCode = await p.confirm({
      message: "Configure ARCS with OpenCode?",
      initialValue: true,
    });

    if (p.isCancel(confirmOpenCode)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }
    if (confirmOpenCode) {
      selectedPlatforms.push("opencode");
    }
  } else if (hasClaudeCode) {
    const confirmClaude = await p.confirm({
      message: "Configure ARCS with Claude Code?",
      initialValue: true,
    });
    if (p.isCancel(confirmClaude)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }
    if (confirmClaude) {
      selectedPlatforms.push("claudecode");
    }
  }

  const selectedOpenCode = selectedPlatforms.includes("opencode");
  const selectedClaudeCode = selectedPlatforms.includes("claudecode");

  let opencodeAgentActive = false;
  let claudecodeDeployed = false;
  let opencodeModelVariants: ModelVariants | undefined;
  const arcsConfig = readConfigOrDefault();

  // ── OpenCode configuration and installation flow ──────────────────────────
  if (selectedOpenCode) {
    // ── Model configuration ───────────────────────────────────────────────────
    const configDiagnosis = await diagnoseOpenCodeConfig();
    const openCodeConfig = configDiagnosis.status === "ok" ? configDiagnosis.config : null;
    const preFills = extractModelPreFills(openCodeConfig);
    if (arcsConfig.opencodeModelVariants) {
      preFills.variants = arcsConfig.opencodeModelVariants;
    }

    if (configDiagnosis.status === "ok") {
      p.note(
        `Found models:\n  model: ${preFills.heavy || "(not set)"}\n  small_model: ${preFills.light || "(not set)"}\n  variants: ${formatVariants(preFills)}`,
        "OpenCode Config",
      );
    } else if (configDiagnosis.status === "corrupt") {
      p.note(
        `Config exists at ${configDiagnosis.path} but failed to parse:\n  ${configDiagnosis.error}\n\nFix the JSON syntax error and re-run, or enter model identifiers manually below to continue.`,
        "OpenCode Config — INVALID JSON",
      );
    } else {
      p.note(
        "No opencode config found at ~/.config/opencode/opencode.json\nEnter model identifiers manually below.",
        "OpenCode Config",
      );
    }

    // ── Reuse fast path ───────────────────────────────────────────────────────
    // Only offered when OpenCode is already fully configured: the config parses,
    // the ARCS agents are registered, and the required heavy/standard/light tiers
    // resolved to real model identifiers.
    const reusableModelConfig: ModelTierConfig | null =
      configDiagnosis.status === "ok" &&
      opencodeHasAgent() &&
      preFills.heavy &&
      preFills.standard &&
      preFills.light
        ? { ...preFills }
        : null;

    // T004 will wire modelConfig into agent registration calls below.
    let modelConfig: ModelTierConfig | null = null;

    if (reusableModelConfig) {
      const reuseExisting = await p.confirm({
        message:
          "Reuse the existing OpenCode model config?\n" +
          `  heavy: ${reusableModelConfig.heavy}\n` +
          `  standard: ${reusableModelConfig.standard}\n` +
          `  light: ${reusableModelConfig.light}\n` +
          `  variants: ${formatVariants(reusableModelConfig)}`,
        initialValue: true,
      });

      // Deliberate exception to this file's convention: every other p.isCancel()
      // here aborts the whole wizard with process.exit(0). Cancelling *this*
      // prompt means "let me pick models again" — a normal outcome, not a signal
      // to abort the entire `arcs init` run — so it falls through to the regular
      // prompt sequence below. Do not "fix" this to match the surrounding pattern.
      if (!p.isCancel(reuseExisting) && reuseExisting) {
        modelConfig = reusableModelConfig;
      }
    }

    if (!modelConfig) {
      // Fetch available models from authenticated providers
      const availableModels = await getAvailableModels(preFills.heavy);

      const heavyModel = await selectModel(
        "Heavy model (reasoning, synthesis)",
        availableModels,
        preFills.heavy,
      );

      if (p.isCancel(heavyModel)) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }

      p.note(`Used by: ${tierAgentNames("heavy")}`, "Heavy tier agents");

      const standardModel = await selectModel(
        "Standard model (general purpose)",
        availableModels,
        preFills.standard,
      );

      if (p.isCancel(standardModel)) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }

      p.note(`Used by: ${tierAgentNames("standard")}`, "Standard tier agents");

      const lightModel = await selectModel(
        "Light/fast model (read-only, exploration)",
        availableModels,
        preFills.light,
      );

      if (p.isCancel(lightModel)) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }

      p.note(`Used by: ${tierAgentNames("light")}`, "Light tier agents");

      const variants = {
        heavy: await selectVariant("Heavy model variant", preFills.variants?.heavy),
        standard: await selectVariant("Standard model variant", preFills.variants?.standard),
        light: await selectVariant("Light model variant", preFills.variants?.light),
      };

      if (Object.values(variants).some((variant) => p.isCancel(variant))) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }

      modelConfig = {
        heavy: heavyModel as string,
        standard: standardModel as string,
        light: lightModel as string,
        variants: variants as ModelVariants,
      };

      // Step 3.5e — Optional per-agent customization
      const customizeAgents = await p.confirm({
        message: "Customize model for individual agents?",
        initialValue: false,
      });

      if (p.isCancel(customizeAgents)) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }

      if (customizeAgents) {
        const agentTiers = [
          ...getActiveAgents()
            .filter((agent) => agent.kind === "subagent" && agent.tier !== "standard")
            .map((agent) => ({ name: agent.id, tier: agent.tier })),
          ...HOST_AGENT_TIERS,
        ];

        p.note(
          "Select a model for each agent, or keep the tier default.",
          "Per-Agent Customization",
        );

        const perAgent: Record<string, string> = {};

        for (const agent of agentTiers) {
          const tierModel = modelConfig[agent.tier] ?? modelConfig.heavy;
          const override = await selectModelForAgent(
            `${agent.name} [${agent.tier}: ${tierModel}]`,
            availableModels,
            tierModel,
          );

          if (p.isCancel(override)) {
            p.cancel("Setup cancelled.");
            process.exit(0);
          }

          if (override && override !== tierModel) {
            perAgent[agent.name] = override as string;
          }
        }

        if (Object.keys(perAgent).length > 0) {
          modelConfig.perAgent = perAgent;
        }
      }
    }

    // ── Register OpenCode agent (orchestrate always enabled if opencode is installed) ──────────────────
    const alreadyHasAgent = opencodeHasAgent();
    opencodeAgentActive = alreadyHasAgent;

    if (alreadyHasAgent) {
      // Already registered — skip the registration confirm, but still offer the
      // primary pick: changing the default orchestrator is the main reason to
      // re-run the wizard. Read the installed default first (writeOpencodeAgent
      // overwrites it) and pre-select it so Enter is a no-op, not a reset.
      const primaryAgentId = await selectPrimaryAgent("OpenCode", readOpencodePrimaryAgentId());
      const agentResult = writeOpencodeAgent(modelConfig, primaryAgentId);
      opencodeAgentActive = true;
      p.note(
        [
          `${color.green("✔")} Updated agents: ${color.dim(displayPath(agentResult.configPath))}`,
          `${color.green("✔")} Refreshed prompts: ${color.dim(displayPath(agentResult.promptPath))}, ${color.dim(displayPath(agentResult.cavemanPromptPath))}`,
        ].join("\n"),
        "OpenCode Agent",
      );
    } else {
      const shouldRegister = await p.confirm({
        message: `Register ${color.cyan("ARCS - (Orchestrator)")}, ${color.cyan("ARCS - Flash")} and ${color.cyan("ARCS - Caveman")} as primary agents in OpenCode? (Tab-switchable alongside Build/Plan)`,
        initialValue: true,
      });

      if (p.isCancel(shouldRegister)) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }

      if (shouldRegister) {
        const primaryAgentId = await selectPrimaryAgent("OpenCode");
        const agentResult = writeOpencodeAgent(modelConfig, primaryAgentId);
        opencodeAgentActive = true;
        const verb = agentResult.action === "created" ? "Created" : "Updated";
        p.note(
          [
            `${color.green("✔")} ${verb} agents: ${color.dim(displayPath(agentResult.configPath))}`,
            `${color.green("✔")} Wrote prompts: ${color.dim(displayPath(agentResult.promptPath))}, ${color.dim(displayPath(agentResult.cavemanPromptPath))}`,
            "",
            `Switch to ${color.cyan("ARCS - (Orchestrator)")} or ${color.cyan("ARCS - Caveman")} with ${color.bold("Tab")} in OpenCode.`,
            `${color.dim("Caveman = same capabilities, ~65% fewer output tokens.")}`,
          ].join("\n"),
          "OpenCode Agent",
        );
      } else {
        p.note(`${color.yellow("⊘")} Skipped OpenCode agent registration`, "OpenCode Agent");
      }
    }

    if (!opencodeAgentActive) {
      p.note(
        `${color.yellow("⊘")} Skipped bundled OpenCode ARCS Bundle install because the user declined ARCS Orchestrator registration`,
        "OpenCode ARCS Bundle",
      );
    } else {
      const detection = detectArcsBundleInstall();

      if (detection.state === "foreign-existing") {
        const shouldReplace = await p.confirm({
          message:
            "Replace the active OpenCode ARCS bundle setup with the bundled ARCS-customized version? Future arcs config runs will keep it synced.",
          initialValue: true,
        });

        if (p.isCancel(shouldReplace)) {
          p.cancel("Setup cancelled.");
          process.exit(0);
        }

        if (shouldReplace) {
          const result = installArcsBundle({ autoConfirmReplacement: true });
          p.note(result.summary, "OpenCode ARCS Bundle");
        } else {
          p.note(
            `${color.yellow("⊘")} Skipped OpenCode bundled ARCS Bundle install`,
            "OpenCode ARCS Bundle",
          );
        }
      } else {
        const result = installArcsBundle({ autoConfirmReplacement: false });
        p.note(result.summary, "OpenCode ARCS Bundle");
      }

      // ── Apply model config to all agent entries ────────────────────────────────
      // Runs after bundle install to overwrite hardcoded manifest models
      // with the user's configured tier values.
      applyAgentModelConfig(modelConfig);
    }

    opencodeModelVariants = modelConfig?.variants ?? {
      heavy: DEFAULT_MODEL_VARIANT,
      standard: DEFAULT_MODEL_VARIANT,
      light: DEFAULT_MODEL_VARIANT,
    };
  }

  // ── Claude Code support ───────────────────────────────────────────────────
  if (selectedClaudeCode) {
    const shouldDeployClaude = await p.confirm({
      message: "Deploy ARCS sub-agents to Claude Code?",
      initialValue: true,
    });

    if (p.isCancel(shouldDeployClaude)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    if (shouldDeployClaude) {
      // ── Reuse fast path ───────────────────────────────────────────────────
      // Only offered when a previous deploy left a readable bundle manifest that
      // recorded the required three tiers. A missing/corrupt manifest — or a valid one
      // whose required tierModels are absent or incomplete — falls through to the
      // tier prompt sequence below.
      const claudeBundleDiagnosis = await diagnoseClaudeCodeBundle();
      const reusableClaudeModels =
        claudeBundleDiagnosis.status === "ok" && claudeBundleDiagnosis.tierModels
          ? claudeBundleDiagnosis.tierModels
          : null;

      let claudeModelConfig: ModelTierConfig | null = null;

      if (reusableClaudeModels) {
        const reuseExistingClaude = await p.confirm({
          message: [
            "Reuse the existing Claude Code model config?",
            `  heavy: ${reusableClaudeModels.heavy}`,
            `  standard: ${reusableClaudeModels.standard}`,
            `  light: ${reusableClaudeModels.light}`,
          ].join("\n"),
          initialValue: true,
        });

        // Deliberate exception to this file's convention: every other p.isCancel()
        // here aborts the whole wizard with process.exit(0). Cancelling *this*
        // prompt means "let me pick models again" — a normal outcome, not a signal
        // to abort the entire `arcs init` run — so it falls through to the regular
        // tier prompts below. Do not "fix" this to match the surrounding pattern.
        if (!p.isCancel(reuseExistingClaude) && reuseExistingClaude) {
          claudeModelConfig = { ...reusableClaudeModels };
        }
      }

      if (!claudeModelConfig) {
        // ── Model selection for Claude Code ─────────────────────────────────
        const currentClaudeModel = await readClaudeCodeCurrentModel();
        const claudeAvailableModels = getClaudeCodeModels();

        p.note(
          "ARCS agents are grouped into three tiers.\n" +
            `  Heavy  — reasoning & synthesis (${registryTierAgentNames("heavy")})\n` +
            `  Standard — orchestration (${registryTierAgentNames("standard")})\n` +
            `  Light  — read-only exploration (${registryTierAgentNames("light")})\n\n` +
            'Use "inherit" to delegate model choice to Claude Code defaults.',
          "Claude Code Model Tiers",
        );

        const claudeHeavyModel = await selectModel(
          "Heavy model (reasoning, synthesis)",
          claudeAvailableModels,
          currentClaudeModel || "opus",
        );
        if (p.isCancel(claudeHeavyModel)) {
          p.cancel("Setup cancelled.");
          process.exit(0);
        }

        const claudeStandardModel = await selectModel(
          "Standard model (orchestration)",
          claudeAvailableModels,
          currentClaudeModel || "sonnet",
        );
        if (p.isCancel(claudeStandardModel)) {
          p.cancel("Setup cancelled.");
          process.exit(0);
        }

        const claudeLightModel = await selectModel(
          "Light/fast model (read-only, exploration)",
          claudeAvailableModels,
          currentClaudeModel || "haiku",
        );
        if (p.isCancel(claudeLightModel)) {
          p.cancel("Setup cancelled.");
          process.exit(0);
        }

        claudeModelConfig = {
          heavy: claudeHeavyModel as string,
          standard: claudeStandardModel as string,
          light: claudeLightModel as string,
        };
      }

      // Pre-select the primary the last deploy installed (recorded as
      // `agent` in ~/.claude/settings.json) so a redeploy preserves it on Enter.
      const claudePrimaryAgentId = await selectPrimaryAgent(
        "Claude Code",
        await readClaudeCodeCurrentPrimaryAgent(),
      );

      const sClaude = p.spinner();
      sClaude.start("Deploying ARCS sub-agents to Claude Code…");

      try {
        const repoRoot = resolve(import.meta.dirname, "../..");
        const scriptPath = resolve(repoRoot, "scripts/deploy-claudecode-bundle.mjs");

        const proc = spawnSync("node", [scriptPath], {
          env: {
            ...process.env,
            DEPLOY_DRY_RUN: "false",
            DEPLOY_MODEL_HEAVY: claudeModelConfig!.heavy,
            DEPLOY_MODEL_STANDARD: claudeModelConfig!.standard,
            DEPLOY_MODEL_LIGHT: claudeModelConfig!.light,
            DEPLOY_PRIMARY_AGENT: claudePrimaryAgentId,
          },
          encoding: "utf-8",
        });

        if (proc.status === 0) {
          claudecodeDeployed = true;
          sClaude.stop("Claude Code deployment complete.");

          if (proc.stdout) {
            try {
              const res = JSON.parse(proc.stdout);
              const summaryLines = [
                `${color.green("✔")} Source: ${res.source}`,
                `${color.green("✔")} Destination: ${res.destination}`,
                `${color.green("✔")} Heavy: ${color.cyan(res.modelConfig?.heavy || "inherit")}  |  Standard: ${color.cyan(res.modelConfig?.standard || "inherit")}  |  Light: ${color.cyan(res.modelConfig?.light || "inherit")}`,
                `${color.green("✔")} Files added: ${res.filesAdded?.length || 0}`,
                `${color.green("✔")} Files changed: ${res.filesChanged?.length || 0}`,
                `${color.green("✔")} Files removed: ${res.filesRemoved?.length || 0}`,
              ];
              p.note(summaryLines.join("\n"), "Claude Code Deployment Summary");
            } catch {
              p.note(
                "Successfully deployed but summary output was unparseable.",
                "Claude Code Deployment",
              );
            }
          } else {
            p.note("Successfully deployed to Claude Code.", "Claude Code Deployment");
          }
        } else {
          sClaude.stop("Claude Code deployment failed.");
          p.note(
            proc.stderr || "deploy-claudecode-bundle.mjs failed with non-zero exit code.",
            "Error",
          );
        }
      } catch (err) {
        sClaude.stop("Claude Code deployment failed.");
        p.note(err instanceof Error ? err.message : String(err), "Error");
      }
    } else {
      p.note(`${color.yellow("⊘")} Skipped Claude Code deployment`, "Claude Code Agent");
    }
  }

  // ── Build config ──────────────────────────────────────────────────────────
  const ides: string[] = [];
  if (selectedOpenCode && opencodeAgentActive) {
    ides.push("opencode");
  }
  if (claudecodeDeployed) {
    ides.push("claudecode");
  }

  const config: ArcsConfig = {
    ...arcsConfig,
    version: "1",
    ides,
    ...(opencodeModelVariants ? { opencodeModelVariants } : {}),
  };

  // ── Write ARCS config ───────────────────────────────────────────────────
  const sWrite = p.spinner();
  sWrite.start("Writing configuration…");
  writeConfig(config);
  sWrite.stop("Configuration saved.");

  // ── Optional codegraph installation ─────────────────────────────────────────
  // Derive codegraph install targets from the platforms the user selected.
  // platform "claudecode" maps to codegraph's "claude" target. Never use
  // "auto" — that would wire unselected hosts (Cursor/Codex/Hermes).
  const codegraphTargets =
    [selectedOpenCode && "opencode", selectedClaudeCode && "claude"].filter(Boolean).join(",") ||
    "opencode";
  await promptCodegraphInstall(codegraphTargets);

  // ── Optional RTK installation ───────────────────────────────────────────────
  // `rtk init -g` always covers Claude Code; `--opencode` additionally installs
  // the OpenCode plugin — so only the opencode selection changes the wiring.
  // The Claude Code selection is passed along so the prompt can ask before
  // touching an unselected host.
  await promptRtkInstall(selectedOpenCode, selectedClaudeCode);

  p.outro(
    color.green("Done!") +
      " You can re-run this setup at any time with " +
      color.cyan("npm run init"),
  );
}

// ---------------------------------------------------------------------------
// Model Selection Helper
// ---------------------------------------------------------------------------

const CUSTOM_MODEL_SENTINEL = "__custom__";
const KEEP_DEFAULT_SENTINEL = "__keep_default__";
const VARIANT_OPTIONS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

function formatVariants(config: ModelTierConfig): string {
  const variants = config.variants;
  return `heavy=${variants?.heavy || DEFAULT_MODEL_VARIANT}, standard=${variants?.standard || DEFAULT_MODEL_VARIANT}, light=${variants?.light || DEFAULT_MODEL_VARIANT}`;
}

async function selectVariant(
  message: string,
  currentValue = DEFAULT_MODEL_VARIANT,
): Promise<string | symbol> {
  const selected = await p.select({
    message,
    options: [
      ...VARIANT_OPTIONS.map((value) => ({ value, label: value })),
      { value: CUSTOM_MODEL_SENTINEL, label: "Enter custom variant" },
    ],
    initialValue: currentValue || DEFAULT_MODEL_VARIANT,
  });
  if (p.isCancel(selected)) return selected;
  if (selected === CUSTOM_MODEL_SENTINEL) {
    const custom = await p.text({ message: `${message} (custom)`, initialValue: currentValue });
    if (p.isCancel(custom)) return custom;
    return (custom as string).trim() || DEFAULT_MODEL_VARIANT;
  }
  return VARIANT_OPTIONS.includes(selected as string)
    ? (selected as string)
    : DEFAULT_MODEL_VARIANT;
}

/**
 * Hints for list entries that are not real model identifiers and would
 * otherwise read as one. Keyed by the literal option value.
 */
const MODEL_OPTION_HINTS: Record<string, string> = {
  inherit: "defer to the host session's model",
};

/**
 * Per-agent model selection with "Keep default" as the first option.
 */
async function selectModelForAgent(
  message: string,
  availableModels: ProviderModels[],
  defaultModel: string,
): Promise<string | symbol> {
  if (availableModels.length === 0) {
    // No providers discovered — fall back to text input
    const result = await p.text({
      message: `${message}`,
      placeholder: "Enter to keep default",
      initialValue: "",
    });
    if (p.isCancel(result)) return result;
    const trimmed = (result as string).trim();
    return trimmed === "" ? defaultModel : trimmed;
  }

  const options: Array<{ value: string; label: string; hint?: string }> = [];

  options.push({
    value: KEEP_DEFAULT_SENTINEL,
    label: `Keep default (${defaultModel})`,
  });

  for (const group of availableModels) {
    options.push({
      value: `__sep_${group.provider}__`,
      label: `── ${group.provider} ──`,
      hint: "separator",
    });
    for (const model of group.models) {
      if (model === defaultModel) continue; // already shown as "keep default"
      options.push({
        value: model,
        label: model,
      });
    }
  }

  options.push({
    value: CUSTOM_MODEL_SENTINEL,
    label: "Enter custom model ID",
  });

  const selected = await p.select({
    message,
    options,
    initialValue: KEEP_DEFAULT_SENTINEL,
  });

  if (p.isCancel(selected)) return selected;

  if (typeof selected === "string" && selected.startsWith("__sep_")) {
    return selectModelForAgent(message, availableModels, defaultModel);
  }

  if (selected === KEEP_DEFAULT_SENTINEL) {
    return defaultModel;
  }

  if (selected === CUSTOM_MODEL_SENTINEL) {
    const custom = await p.text({
      message: `${message} (custom)`,
      placeholder: "e.g. github-copilot/claude-sonnet-4.6",
      initialValue: "",
    });
    if (p.isCancel(custom)) return custom;
    const trimmed = (custom as string).trim();
    return trimmed === "" ? defaultModel : trimmed;
  }

  return selected as string;
}

/**
 * Presents a select UI with available models grouped by provider.
 * Falls back to text input if no models available or user picks custom.
 */
async function selectModel(
  message: string,
  availableModels: ProviderModels[],
  currentValue: string,
): Promise<string | symbol> {
  if (availableModels.length === 0) {
    // No providers discovered — fall back to text input
    return p.text({
      message,
      placeholder: "e.g. github-copilot/claude-sonnet-4.6",
      initialValue: currentValue,
    });
  }

  const options: Array<{ value: string; label: string; hint?: string }> = [];

  for (const group of availableModels) {
    // Add separator-style label for provider group
    options.push({
      value: `__sep_${group.provider}__`,
      label: `── ${group.provider} ──`,
      hint: "separator",
    });
    for (const model of group.models) {
      options.push({
        value: model,
        label: model,
        hint: model === currentValue ? "current" : MODEL_OPTION_HINTS[model],
      });
    }
  }

  options.push({
    value: CUSTOM_MODEL_SENTINEL,
    label: "Enter custom model ID",
  });

  const selected = await p.select({
    message,
    options,
    initialValue: currentValue || undefined,
  });

  if (p.isCancel(selected)) return selected;

  // Skip separators — shouldn't normally happen but guard
  if (typeof selected === "string" && selected.startsWith("__sep_")) {
    return selectModel(message, availableModels, currentValue);
  }

  if (selected === CUSTOM_MODEL_SENTINEL) {
    return p.text({
      message: `${message} (custom)`,
      placeholder: "e.g. github-copilot/claude-sonnet-4.6",
      initialValue: currentValue,
    });
  }

  return selected as string;
}

// ---------------------------------------------------------------------------
// Codegraph Installation Prompt
// ---------------------------------------------------------------------------

const CODEGRAPH_URL = "https://github.com/colbymchenry/codegraph";

/**
 * Wires codegraph into opencode (MCP) and builds the index for the current
 * project. All steps are best-effort and non-fatal — a failure at any
 * sub-step shows a note and continues. Never throws.
 */
function wireCodegraph(targets: string): void {
  // (a) Wire codegraph MCP into the selected host(s) non-interactively.
  try {
    const wire = spawnSync("codegraph", ["install", `--target=${targets}`, "--yes"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
    });
    if (wire.status === 0) {
      p.log.info(color.dim(`${color.green("✔")} Wired codegraph MCP into ${targets}`));
    } else {
      p.note(
        [
          `${color.yellow("⚠")} Could not wire codegraph into ${targets} automatically.`,
          `Run manually:  ${color.dim(`codegraph install --target=${targets} --yes`)}`,
        ].join("\n"),
        "Optional: Codegraph",
      );
    }
  } catch {
    p.note(
      [
        `${color.yellow("⚠")} Could not wire codegraph into ${targets} automatically.`,
        `Run manually:  ${color.dim(`codegraph install --target=${targets} --yes`)}`,
      ].join("\n"),
      "Optional: Codegraph",
    );
  }

  // (b) Build the index for the current project.
  try {
    const index = spawnSync("codegraph", ["index", process.cwd(), "--force", "--quiet"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
    });
    if (index.status === 0) {
      p.log.info(color.dim(`${color.green("✔")} Indexed current project`));
    } else {
      p.note(
        [
          `${color.yellow("⚠")} Could not index the current project automatically.`,
          `Run manually:  ${color.dim(`codegraph index ${process.cwd()} --force --quiet`)}`,
        ].join("\n"),
        "Optional: Codegraph",
      );
    }
  } catch {
    p.note(
      [
        `${color.yellow("⚠")} Could not index the current project automatically.`,
        `Run manually:  ${color.dim(`codegraph index ${process.cwd()} --force --quiet`)}`,
      ].join("\n"),
      "Optional: Codegraph",
    );
  }

  // (c) Summarize what was wired.
  const final = detectCodegraph();
  p.note(
    [
      `${color.green("✔")} Codegraph${final.version ? ` v${final.version}` : ""} ready`,
      `${color.green("✔")} ${targets} MCP wired`,
      `${color.green("✔")} Current project indexed`,
    ].join("\n"),
    "Codegraph",
  );
}

/**
 * Prompts the user to install codegraph if it's not already available,
 * using a platform-based installer. Once available (freshly installed or
 * pre-existing), wires the codegraph MCP into opencode and indexes the
 * current project. Gracefully handles all decline/failure paths — never
 * throws and never exits the wizard.
 */
export async function promptCodegraphInstall(targets: string): Promise<void> {
  const info = detectCodegraph();
  if (info.available) {
    // Already installed — skip install but still ensure host wiring + project init.
    wireCodegraph(targets);
    return;
  }

  p.note(
    [
      "Codegraph gives agents a pre-indexed code graph for efficient exploration",
      "without full file reads (MCP-based). 100% local.",
      "",
      color.cyan(CODEGRAPH_URL),
    ].join("\n"),
    "Optional: Codegraph",
  );

  const shouldInstall = await p.confirm({
    message: "Install codegraph now?",
    initialValue: false,
  });

  if (p.isCancel(shouldInstall) || !shouldInstall) {
    p.log.info(color.dim(`Install later:  npx @colbymchenry/codegraph  |  ${CODEGRAPH_URL}`));
    return;
  }

  const s = p.spinner();
  s.start("Installing codegraph…");

  let installed = false;

  // ── Platform-based install ────────────────────────────────────────────────
  try {
    const platformInstall =
      process.platform === "win32"
        ? spawnSync(
            "powershell",
            [
              "-Command",
              "irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex",
            ],
            { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 120_000 },
          )
        : spawnSync(
            "sh",
            [
              "-c",
              "curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh",
            ],
            { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 120_000 },
          );
    if (platformInstall.status === 0) {
      installed = true;
    }
  } catch {
    // Fall through to npm fallback.
  }

  // ── Fallback: npm global install ──────────────────────────────────────────
  if (!installed) {
    try {
      const npmInstall = spawnSync("npm", ["i", "-g", "@colbymchenry/codegraph"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 120_000,
      });
      if (npmInstall.status === 0) {
        installed = true;
      }
    } catch {
      // All installers failed.
    }
  }

  if (!installed) {
    s.stop(
      [
        `${color.yellow("⚠")} Could not install codegraph — all installers failed.`,
        `Install manually:  ${color.cyan(CODEGRAPH_URL)}`,
      ].join("\n"),
    );
    return;
  }

  s.stop(`${color.green("✔")} Codegraph installed`);

  // After a successful install, wire the selected host(s) + index the project.
  wireCodegraph(targets);
}

// ---------------------------------------------------------------------------
// RTK Installation Prompt
// ---------------------------------------------------------------------------

const RTK_URL = "https://github.com/rtk-ai/rtk";

/**
 * Wires RTK instructions + the auto-rewrite hook into the selected host(s).
 * `rtk init -g` always covers Claude Code; `--opencode` additionally installs
 * the OpenCode plugin. Best-effort and non-fatal — never throws.
 */
function wireRtk(withOpencode: boolean): void {
  const args = ["init", "-g"];
  if (withOpencode) args.push("--opencode");
  args.push("--auto-patch");
  const manualCommand = `rtk ${args.join(" ")}`;
  const wiredHosts = withOpencode ? "opencode, claude" : "claude";

  try {
    const wire = spawnSync("rtk", args, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
    });
    if (wire.status === 0) {
      p.log.info(color.dim(`${color.green("✔")} Wired RTK into ${wiredHosts}`));
    } else {
      p.note(
        [
          `${color.yellow("⚠")} Could not wire RTK into ${wiredHosts} automatically.`,
          `Run manually:  ${color.dim(manualCommand)}`,
        ].join("\n"),
        "Optional: RTK",
      );
    }
  } catch {
    p.note(
      [
        `${color.yellow("⚠")} Could not wire RTK into ${wiredHosts} automatically.`,
        `Run manually:  ${color.dim(manualCommand)}`,
      ].join("\n"),
      "Optional: RTK",
    );
  }
}

/**
 * Prompts the user to install RTK if it's not already available, using the
 * official install script with a Homebrew fallback. Once available (freshly
 * installed or pre-existing), wires RTK instructions + the auto-rewrite hook
 * into the selected host(s) — asking first when the wiring would also touch
 * an unselected Claude Code config. Gracefully handles all decline/failure
 * paths — never throws and never exits the wizard.
 */
export async function promptRtkInstall(
  withOpencode: boolean,
  claudeSelected: boolean,
): Promise<void> {
  const info = detectRtk();
  if (info.available) {
    // `rtk init -g` is global — it configures Claude Code even when only
    // OpenCode was selected. Ask before touching an unselected host.
    if (withOpencode && !claudeSelected) {
      const proceed = await p.confirm({
        message: "Wire RTK for OpenCode? (rtk init -g is global — it also configures Claude Code)",
        initialValue: true,
      });

      if (p.isCancel(proceed) || !proceed) {
        p.log.info(
          color.dim("Skipped RTK wiring. Run manually:  rtk init -g --opencode --auto-patch"),
        );
        return;
      }
    }

    wireRtk(withOpencode);
    return;
  }

  p.note(
    [
      "RTK proxies agent shell commands and filters noise from their output",
      "(60-90% fewer tokens on git/test/build commands). 100% local.",
      "Wiring runs `rtk init -g` — global: it always configures Claude Code;",
      "`--opencode` additionally installs the OpenCode plugin.",
      "",
      color.cyan(RTK_URL),
    ].join("\n"),
    "Optional: RTK",
  );

  // No automated Windows installer is published — point at the releases page
  // instead of offering an install that cannot succeed.
  if (process.platform === "win32") {
    p.log.info(color.dim(`Install manually:  ${RTK_URL}/releases`));
    return;
  }

  const shouldInstall = await p.confirm({
    message: "Install RTK now?",
    initialValue: false,
  });

  if (p.isCancel(shouldInstall) || !shouldInstall) {
    p.log.info(color.dim(`Install later:  brew install rtk  |  ${RTK_URL}`));
    return;
  }

  const s = p.spinner();
  s.start("Installing RTK…");

  let installed = false;

  // ── Platform-based install ────────────────────────────────────────────────
  try {
    const platformInstall = spawnSync(
      "sh",
      [
        "-c",
        "curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh",
      ],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 120_000 },
    );
    if (platformInstall.status === 0) {
      installed = true;
    }
  } catch {
    // Fall through to Homebrew fallback.
  }

  // ── Fallback: Homebrew ────────────────────────────────────────────────────
  if (!installed) {
    try {
      const brewInstall = spawnSync("brew", ["install", "rtk"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 120_000,
      });
      if (brewInstall.status === 0) {
        installed = true;
      }
    } catch {
      // All installers failed.
    }
  }

  if (!installed) {
    s.stop(
      [
        `${color.yellow("⚠")} Could not install RTK — all installers failed.`,
        `Install manually:  ${color.cyan(RTK_URL)}`,
      ].join("\n"),
    );
    return;
  }

  s.stop(`${color.green("✔")} RTK installed`);

  // After a successful install, wire the selected host(s). Consent was given
  // via the install confirm, which follows the note disclosing the wiring.
  wireRtk(withOpencode);
}
