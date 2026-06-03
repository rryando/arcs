/**
 * Diagram store — encapsulates the manage-diagram.mjs subprocess.
 *
 * CLI command handlers should call into this module rather than spawning
 * the script directly. Centralizes:
 *   - script discovery (repo-local vs ~/.config/opencode)
 *   - diagram file path resolution
 *   - subprocess invocation with consistent stdio + timeout
 *   - task-status → diagram-status namespace mapping
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { getDataDir } from "./paths.js";
import type { TaskStatus } from "./storage-utils.js";

export interface DiagramUpdateResult {
  diagramUpdated: boolean;
  diagramError?: string;
}

/**
 * Locate the manage-diagram.mjs script. Search order:
 *   1. Repo-local bundle (development checkout)
 *   2. OpenCode skill install (~/.config/opencode/skills/arcs/to-diagram/...)
 *   3. Claude Code skill install (~/.claude/skills/arcs-to-diagram/...)
 *
 * The Claude Code path uses the `arcs-` prefix because Claude Code skills
 * are flat under ~/.claude/skills/ — see scripts/deploy-claudecode-bundle.mjs.
 */
export function findDiagramScript(): string | undefined {
  const candidates = [
    resolve(
      import.meta.dirname,
      "../../opencode/arcs/skills/to-diagram/scripts/manage-diagram.mjs",
    ),
    resolve(homedir(), ".config/opencode/skills/arcs/to-diagram/scripts/manage-diagram.mjs"),
    resolve(homedir(), ".claude/skills/arcs-to-diagram/scripts/manage-diagram.mjs"),
  ];

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return undefined;
}

export function resolveDiagramPath(slug: string, planId: string): string {
  const dataDir = getDataDir();
  return resolve(dataDir, "projects", slug, "plans", `${planId}.diagram.mmd`);
}

/**
 * Run the manage-diagram.mjs script and return trimmed stdout.
 * Throws on non-zero exit; caller is responsible for error mapping.
 */
export function runDiagramScript(
  scriptPath: string,
  subcommand: string,
  diagramPath: string,
  extraArgs: string[] = [],
): string {
  const argsStr = extraArgs.map((a) => `"${a}"`).join(" ");
  return execSync(
    `node "${scriptPath}" ${subcommand} "${diagramPath}"${argsStr ? ` ${argsStr}` : ""}`,
    {
      encoding: "utf-8",
      timeout: 10000,
      // Capture stderr so script error output never leaks to the parent's
      // stderr — keeps --json output clean and parseable for agents.
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

/**
 * Map task status (snake_case in the ARCS task model) to diagram classDef
 * status (camelCase in the Mermaid script). The two namespaces are
 * intentionally distinct — task statuses follow Python/JSON convention,
 * diagram statuses match the classDef identifiers.
 */
export function taskStatusToDiagramStatus(status: TaskStatus): string {
  switch (status) {
    case "in_progress":
      return "inProgress";
    case "done":
      return "done";
    case "cancelled":
      return "blocked";
    case "backlog":
      return "backlog";
  }
}

/**
 * Best-effort diagram node status update. Returns a structured result
 * rather than throwing — callers expect this to fail gracefully when
 * the diagram or script is absent.
 */
export function attemptDiagramUpdate(
  slug: string,
  planId: string,
  nodeId: string,
  status: TaskStatus,
): DiagramUpdateResult {
  const diagramPath = resolveDiagramPath(slug, planId);

  if (!existsSync(diagramPath)) {
    return { diagramUpdated: false, diagramError: "Diagram file not found" };
  }

  const scriptPath = findDiagramScript();
  if (!scriptPath) {
    return { diagramUpdated: false, diagramError: "manage-diagram.mjs script not found" };
  }

  try {
    runDiagramScript(scriptPath, "status", diagramPath, [
      nodeId,
      taskStatusToDiagramStatus(status),
    ]);
    return { diagramUpdated: true };
  } catch (err) {
    const msg =
      err instanceof Error ? (err as { stderr?: string }).stderr || err.message : String(err);
    return { diagramUpdated: false, diagramError: msg };
  }
}
