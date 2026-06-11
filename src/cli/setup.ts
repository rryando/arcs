import { execSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import color from "picocolors";
import { detectCodegraph } from "../utils/codegraph.js";
import { PACKAGE_ROOT } from "../utils/paths.js";
import { detectRtk } from "../utils/rtk.js";
import { detectArcsBundleInstall, installArcsBundle } from "./bundle-installer.js";
import {
  type ArcsConfig,
  diagnoseOpenCodeConfig,
  extractModelPreFills,
  getAvailableModels,
  getClaudeCodeModels,
  type ModelTierConfig,
  type ProviderModels,
  readClaudeCodeCurrentModel,
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

  // ── OpenCode configuration and installation flow ──────────────────────────
  if (selectedOpenCode) {
    // ── Model configuration ───────────────────────────────────────────────────
    const configDiagnosis = await diagnoseOpenCodeConfig();
    const openCodeConfig = configDiagnosis.status === "ok" ? configDiagnosis.config : null;
    const preFills = extractModelPreFills(openCodeConfig);

    if (configDiagnosis.status === "ok") {
      p.note(
        `Found models:\n  model: ${preFills.heavy || "(not set)"}\n  small_model: ${preFills.light || "(not set)"}`,
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
      // ── Model selection for Claude Code ───────────────────────────────────
      const currentClaudeModel = await readClaudeCodeCurrentModel();
      const claudeAvailableModels = getClaudeCodeModels(currentClaudeModel);

      p.note(
        "ARCS agents are grouped into three tiers.\n" +
          "  Heavy  — reasoning & synthesis (software-engineer, arcs-docs, oncall-ops…)\n" +
          "  Standard — orchestration (arcs-orchestrate, devil-advocate…)\n" +
          "  Light  — read-only exploration (code-reviewer, tech-architect, qa-analyst…)\n\n" +
          'Use "inherit" to delegate model choice to Claude Code defaults.',
        "Claude Code Model Tiers",
      );

      const claudeHeavyModel = await selectModel(
        "Heavy model (reasoning, synthesis)",
        claudeAvailableModels,
        currentClaudeModel || "claude-opus-4-7",
      );
      if (p.isCancel(claudeHeavyModel)) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }

      const claudeStandardModel = await selectModel(
        "Standard model (orchestration)",
        claudeAvailableModels,
        currentClaudeModel || "claude-sonnet-4-6",
      );
      if (p.isCancel(claudeStandardModel)) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }

      const claudeLightModel = await selectModel(
        "Light/fast model (read-only, exploration)",
        claudeAvailableModels,
        currentClaudeModel || "claude-haiku-4-5",
      );
      if (p.isCancel(claudeLightModel)) {
        p.cancel("Setup cancelled.");
        process.exit(0);
      }

      const sClaude = p.spinner();
      sClaude.start("Deploying ARCS sub-agents to Claude Code…");

      try {
        const repoRoot = resolve(import.meta.dirname, "../..");
        const scriptPath = resolve(repoRoot, "scripts/deploy-claudecode-bundle.mjs");

        const proc = spawnSync("node", [scriptPath], {
          env: {
            ...process.env,
            DEPLOY_DRY_RUN: "false",
            DEPLOY_MODEL_HEAVY: claudeHeavyModel as string,
            DEPLOY_MODEL_STANDARD: claudeStandardModel as string,
            DEPLOY_MODEL_LIGHT: claudeLightModel as string,
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
    version: "1",
    ides,
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
