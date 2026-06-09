import { spawnSync } from "node:child_process";
import * as p from "@clack/prompts";
import color from "picocolors";

const CODEGRAPH_URL = "https://github.com/colbymchenry/codegraph";

/**
 * Interactively offers to install codegraph when it is absent.
 *
 * Shows a note about what codegraph provides, then prompts for install. On
 * confirmation it tries the platform installer (curl/powershell) and falls
 * back to a global npm install. Returns `true` only when a fresh install
 * succeeded; returns `false` when the user declines or every installer fails
 * (logging a manual-install hint in that case).
 *
 * Unlike the setup wizard's prompt, this does NOT wire the codegraph MCP into
 * a host — MCP wiring is irrelevant during `arcs project init`, which only
 * needs the binary present so it can build the index and seed proposals.
 * Never throws.
 */
export async function promptAndInstallCodegraph(): Promise<boolean> {
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
    return false;
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
    return false;
  }

  s.stop(`${color.green("✔")} Codegraph installed`);
  return true;
}
