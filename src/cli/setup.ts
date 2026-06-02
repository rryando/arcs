import { execSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import color from "picocolors";
import { detectGraphify } from "../utils/graphify.js";
import { detectArcsBundleInstall, installArcsBundle } from "./bundle-installer.js";
import {
  type ArcsConfig,
  extractModelPreFills,
  getAvailableModels,
  type ModelTierConfig,
  type ProviderModels,
  readOpenCodeConfig,
  writeConfig,
} from "./config.js";
import {
  applyAgentModelConfig,
  displayPath,
  opencodeHasAgent,
  writeOpencodeAgent,
} from "./instructions.js";

// ---------------------------------------------------------------------------
// TUI Wizard
// ---------------------------------------------------------------------------

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
  p.intro(color.bgCyan(color.black(isInit ? " ARCS setup " : " ARCS config ")));

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

  // ── OpenCode configuration and installation flow ──────────────────────────
  if (selectedOpenCode) {
    // ── Model configuration ───────────────────────────────────────────────────
    const openCodeConfig = await readOpenCodeConfig();
    const preFills = extractModelPreFills(openCodeConfig);

    if (openCodeConfig) {
      p.note(
        `Found models:\n  model: ${preFills.heavy || "(not set)"}\n  small_model: ${preFills.light || "(not set)"}`,
        "OpenCode Config",
      );
    } else {
      p.note(
        "No opencode config found at ~/.config/opencode/opencode.json\nEnter model identifiers manually below.",
        "OpenCode Config",
      );
    }

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

    p.note(
      "Used by: software-engineer, docs-researcher, arcs-docs, oncall-ops, system-architect, plan, general",
      "Heavy tier agents",
    );

    const standardModel = await selectModel(
      "Standard model (general purpose)",
      availableModels,
      preFills.standard,
    );

    if (p.isCancel(standardModel)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    p.note("Used by: build, ARCS Orchestrator, ARCS Caveman", "Standard tier agents");

    const lightModel = await selectModel(
      "Light/fast model (read-only, exploration)",
      availableModels,
      preFills.light,
    );

    if (p.isCancel(lightModel)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    p.note("Used by: explore, code-reviewer, tech-architect, qa-analyst", "Light tier agents");

    // T004 will wire modelConfig into agent registration calls below.
    const modelConfig: ModelTierConfig = {
      heavy: heavyModel as string,
      standard: standardModel as string,
      light: lightModel as string,
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
      // Agent tier mapping for display
      const agentTiers: Array<{ name: string; tier: "heavy" | "standard" | "light" }> = [
        { name: "software-engineer", tier: "heavy" },
        { name: "docs-researcher", tier: "heavy" },
        { name: "arcs-docs", tier: "heavy" },
        { name: "oncall-ops", tier: "heavy" },
        { name: "system-architect", tier: "heavy" },
        { name: "plan", tier: "heavy" },
        { name: "general", tier: "heavy" },
        { name: "build", tier: "standard" },
        { name: "explore", tier: "light" },
        { name: "code-reviewer", tier: "light" },
        { name: "tech-architect", tier: "light" },
        { name: "qa-analyst", tier: "light" },
      ];

      p.note("Select a model for each agent, or keep the tier default.", "Per-Agent Customization");

      const perAgent: Record<string, string> = {};

      for (const agent of agentTiers) {
        const tierModel = modelConfig[agent.tier];
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

    // ── Register OpenCode agent (orchestrate always enabled if opencode is installed) ──────────────────
    const alreadyHasAgent = opencodeHasAgent();
    opencodeAgentActive = alreadyHasAgent;

    if (alreadyHasAgent) {
      // Already registered — re-apply silently to keep the entry and prompt up to date
      const agentResult = writeOpencodeAgent(modelConfig);
      opencodeAgentActive = true;
      p.note(
        [
          `${color.green("✔")} Updated agent entries in ${color.dim(displayPath(agentResult.configPath))}`,
          `${color.green("✔")} Refreshed orchestrator prompt at ${color.dim(displayPath(agentResult.promptPath))}`,
          `${color.green("✔")} Refreshed Caveman prompt at ${color.dim(displayPath(agentResult.cavemanPromptPath))}`,
        ].join("\n"),
        "OpenCode Agent",
      );
    } else {
      const shouldRegister = await p.confirm({
        message: `Register ${color.cyan("ARCS - (Orchestrator)")} and ${color.cyan("ARCS - Caveman")} as primary agents in OpenCode? (Tab-switchable alongside Build/Plan)`,
        initialValue: true,
      });

      if (p.isCancel(shouldRegister)) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }

      if (shouldRegister) {
        const agentResult = writeOpencodeAgent(modelConfig);
        opencodeAgentActive = true;
        const verb = agentResult.action === "created" ? "Created" : "Updated";
        p.note(
          [
            `${color.green("✔")} ${verb} agent entries in ${color.dim(displayPath(agentResult.configPath))}`,
            `${color.green("✔")} Wrote orchestrator prompt to ${color.dim(displayPath(agentResult.promptPath))}`,
            `${color.green("✔")} Wrote Caveman prompt to ${color.dim(displayPath(agentResult.cavemanPromptPath))}`,
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
      const sClaude = p.spinner();
      sClaude.start("Deploying ARCS sub-agents to Claude Code…");

      try {
        const repoRoot = resolve(import.meta.dirname, "../..");
        const scriptPath = resolve(repoRoot, "scripts/deploy-claudecode-bundle.mjs");

        const proc = spawnSync("node", [scriptPath], {
          env: {
            ...process.env,
            DEPLOY_DRY_RUN: "false",
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
    version: "1",
    ides,
  };

  // ── Write ARCS config ───────────────────────────────────────────────────
  const sWrite = p.spinner();
  sWrite.start("Writing configuration…");
  writeConfig(config);
  sWrite.stop("Configuration saved.");

  // ── Optional graphify installation ──────────────────────────────────────────
  await promptGraphifyInstall();

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
        hint: model === currentValue ? "current" : undefined,
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
// Graphify Installation Prompt
// ---------------------------------------------------------------------------

/**
 * Detects Python 3.10+ availability and returns the major.minor version,
 * or null if Python is not found or version is insufficient.
 */
function detectPython310(): { version: string; command: string } | null {
  for (const cmd of ["python3", "python"]) {
    try {
      const output = execSync(`${cmd} --version`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      }).trim();
      const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
      if (match) {
        const major = Number.parseInt(match[1], 10);
        const minor = Number.parseInt(match[2], 10);
        if (major >= 3 && minor >= 10) {
          return { version: `${major}.${minor}.${match[3]}`, command: cmd };
        }
      }
    } catch {
      // Command not found or failed, try next
    }
  }
  return null;
}

const GRAPHIFY_URL = "https://github.com/safishamsi/graphify";

/**
 * Prompts the user to install graphify if it's not already available
 * and Python 3.10+ is detected. Gracefully handles all decline/failure paths.
 */
export async function promptGraphifyInstall(): Promise<void> {
  const info = detectGraphify();
  if (info.available) return;

  const python = detectPython310();
  if (!python) {
    p.note(
      [
        "Graphify enables automatic codebase graph analysis.",
        "AI agents get richer structural context without scanning from scratch each session.",
        "",
        `${color.yellow("Requirement not met:")} Python 3.10+ is required but was not found.`,
        "",
        "To enable this capability, install Python 3.10+ then follow:",
        color.cyan(GRAPHIFY_URL),
        "",
        `Then run:  ${color.dim("uv tool install graphifyy")}  (or pipx / pip)`,
      ].join("\n"),
      "Optional: Graphify",
    );
    return;
  }

  p.note(
    [
      "Graphify enables automatic codebase graph analysis.",
      "AI agents get richer structural context without scanning from scratch each session.",
      "",
      color.cyan(GRAPHIFY_URL),
    ].join("\n"),
    "Optional: Graphify",
  );

  const shouldInstall = await p.confirm({
    message: `Install graphify now? (Python ${python.version} detected)`,
    initialValue: false,
  });

  if (p.isCancel(shouldInstall) || !shouldInstall) {
    p.log.info(color.dim(`Install later:  uv tool install graphifyy  |  ${GRAPHIFY_URL}`));
    return;
  }

  const installCommands = [
    "uv tool install graphifyy",
    "pipx install graphifyy",
    "pip install graphifyy",
  ];

  const s = p.spinner();
  s.start("Installing graphify…");

  for (const cmd of installCommands) {
    try {
      execSync(cmd, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60_000,
      });
      s.stop(`${color.green("✔")} Graphify installed via ${color.dim(cmd.split(" ")[0])}`);
      return;
    } catch {
      // Try next installer
    }
  }

  s.stop(
    [
      `${color.yellow("⚠")} Could not install graphify — all installers failed.`,
      `Install manually:  ${color.cyan(GRAPHIFY_URL)}`,
    ].join("\n"),
  );
}
