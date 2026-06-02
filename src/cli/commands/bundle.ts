// ---------------------------------------------------------------------------
// Bundle commands — lint-bundle, deploy-superpowers (registry-based)
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  type CLIResult,
  type CommandFlags,
  defineCommand,
  type ParamDef,
  type ParsedParams,
} from "../command-registry.js";
import { failure, success } from "../output-envelope.js";

// ---------------------------------------------------------------------------
// lint-bundle
// ---------------------------------------------------------------------------

const lintBundleParams = {
  "bundle-root": { type: "string", description: "Override bundle root directory" },
  "config-root": { type: "string", description: "Override config root directory" },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "lint-bundle",
  description: "Validate opencode-bundle manifest integrity",
  mutation: false,
  params: lintBundleParams,
  handler: handleLintBundle,
});

async function handleLintBundle(
  params: ParsedParams<typeof lintBundleParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const bundleRoot = params["bundle-root"];
  const configRoot = params["config-root"];

  try {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const scriptPath = resolve(repoRoot, "scripts/lint-bundle.mjs");

    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (bundleRoot) env.BUNDLE_LINT_BUNDLE_ROOT = bundleRoot;
    if (configRoot) env.BUNDLE_LINT_CONFIG_ROOT = configRoot;

    const proc = spawnSync("node", [scriptPath], {
      cwd: repoRoot,
      env,
      encoding: "utf-8",
    });

    if (proc.stdout) {
      const result = JSON.parse(proc.stdout);
      return success(result);
    }

    return failure("internal_error", proc.stderr || "lint-bundle produced no output");
  } catch (err) {
    return failure("internal_error", err instanceof Error ? err.message : String(err));
  }
}

async function runDeployScript(
  scriptName: string,
  envOverrides: Record<string, string>,
): Promise<CLIResult> {
  try {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const scriptPath = resolve(repoRoot, "scripts", scriptName);

    const env: Record<string, string> = {
      ...process.env,
      DEPLOY_DRY_RUN: "false",
      ...envOverrides,
    } as Record<string, string>;

    const proc = spawnSync("node", [scriptPath], {
      cwd: repoRoot,
      env,
      encoding: "utf-8",
    });

    if (proc.stdout) {
      const result = JSON.parse(proc.stdout);
      return success(result);
    }

    return failure("internal_error", proc.stderr || "deploy script produced no output");
  } catch (err) {
    return failure("internal_error", err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// deploy-superpowers
// ---------------------------------------------------------------------------

const deploySuperpowersParams = {
  "bundle-root": { type: "string", description: "Override bundle root directory" },
  "config-root": { type: "string", description: "Override config root directory" },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "deploy-superpowers",
  description: "Deploy opencode-bundle to ~/.config/opencode",
  mutation: true,
  params: deploySuperpowersParams,
  handler: handleDeploySuperpowers,
});

async function handleDeploySuperpowers(
  params: ParsedParams<typeof deploySuperpowersParams>,
  flags: CommandFlags,
): Promise<CLIResult> {
  const bundleRoot = params["bundle-root"];
  const configRoot = params["config-root"];

  if (flags.dryRun) {
    return success({ dryRun: true, wouldDeploy: true });
  }

  const envOverrides: Record<string, string> = {};
  if (bundleRoot) envOverrides.DEPLOY_BUNDLE_ROOT = bundleRoot;
  if (configRoot) envOverrides.DEPLOY_CONFIG_ROOT = configRoot;

  return runDeployScript("deploy-opencode-bundle.mjs", envOverrides);
}

// ---------------------------------------------------------------------------
// deploy-claudecode-superpowers
// ---------------------------------------------------------------------------

const deployClaudecodeSuperpowersParams = {
  "bundle-root": { type: "string", description: "Override bundle root directory" },
  "config-root": { type: "string", description: "Override config root directory" },
  "project-root": { type: "string", description: "Override project root directory" },
  scope: {
    type: "string",
    description: "Deployment scope (global or project)",
    enum: ["global", "project"],
  },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "deploy-claudecode-superpowers",
  description: "Deploy claudecode-bundle to ~/.claude or .claude",
  mutation: true,
  params: deployClaudecodeSuperpowersParams,
  handler: handleDeployClaudecodeSuperpowers,
});

async function handleDeployClaudecodeSuperpowers(
  params: ParsedParams<typeof deployClaudecodeSuperpowersParams>,
  flags: CommandFlags,
): Promise<CLIResult> {
  const bundleRoot = params["bundle-root"];
  const configRoot = params["config-root"];
  const projectRoot = params["project-root"];
  const scope = params.scope;

  if (flags.dryRun) {
    return success({ dryRun: true, wouldDeploy: true });
  }

  const envOverrides: Record<string, string> = {};
  if (bundleRoot) envOverrides.DEPLOY_BUNDLE_ROOT = bundleRoot;
  if (configRoot) envOverrides.DEPLOY_CONFIG_ROOT = configRoot;
  if (projectRoot) envOverrides.DEPLOY_PROJECT_ROOT = projectRoot;
  if (scope) envOverrides.DEPLOY_SCOPE = scope;

  return runDeployScript("deploy-claudecode-bundle.mjs", envOverrides);
}
