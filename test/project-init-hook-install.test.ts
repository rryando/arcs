// ---------------------------------------------------------------------------
// `arcs project init` — Claude Code hook install offer (gating + non-fatality)
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "./helpers/cli-runner.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

const promptMock = vi.fn();

vi.mock("../src/utils/claude-code-hook-install.js", () => ({
  promptAndInstallClaudeCodeHook: (options: unknown) => promptMock(options),
}));

interface InitData {
  slug: string;
  claudeCodeHook: { settingsPath: string; events: string[] } | null;
}

describe("project init — Claude Code hook install offer", () => {
  const originalIsTTY = process.stdout.isTTY;
  const originalSkipQuickScan = process.env.ARCS_SKIP_QUICK_SCAN;
  const originalSkipHookInstall = process.env.ARCS_SKIP_HOOK_INSTALL;

  beforeEach(() => {
    promptMock.mockReset();
    process.env.ARCS_SKIP_QUICK_SCAN = "1";
    delete process.env.ARCS_SKIP_HOOK_INSTALL;
    process.stdout.isTTY = true;
  });

  afterEach(() => {
    process.stdout.isTTY = originalIsTTY;
    if (originalSkipQuickScan === undefined) delete process.env.ARCS_SKIP_QUICK_SCAN;
    else process.env.ARCS_SKIP_QUICK_SCAN = originalSkipQuickScan;
    if (originalSkipHookInstall === undefined) delete process.env.ARCS_SKIP_HOOK_INSTALL;
    else process.env.ARCS_SKIP_HOOK_INSTALL = originalSkipHookInstall;
  });

  it("offers the install and reports the written settings path", async () => {
    await withTempDataDir(async (dataDir) => {
      promptMock.mockResolvedValue({
        settingsPath: "/ws/.claude/settings.local.json",
        token: "tok",
        hookScriptPath: "/pkg/scripts/claude-code-session-hook.mjs",
        serverUrl: "http://127.0.0.1:4173",
        events: ["SessionStart", "UserPromptSubmit", "SessionEnd"],
      });

      const result = await runCommand("project init", [
        "hook demo",
        "--description=Demo",
        "--path=/ws",
      ]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(promptMock).toHaveBeenCalledTimes(1);
      expect(promptMock.mock.calls[0][0]).toMatchObject({
        workspacePath: "/ws",
        slug: "hook-demo",
        projectDir: `${dataDir}/projects/hook-demo`,
      });
      expect((result.data as InitData).claudeCodeHook).toEqual({
        settingsPath: "/ws/.claude/settings.local.json",
        events: ["SessionStart", "UserPromptSubmit", "SessionEnd"],
      });
    });
  });

  it("reports null when the user declines", async () => {
    await withTempDataDir(async () => {
      promptMock.mockResolvedValue(null);

      const result = await runCommand("project init", [
        "hook decline",
        "--description=Demo",
        "--path=/ws",
      ]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((result.data as InitData).claudeCodeHook).toBeNull();
    });
  });

  it("never fails project init when the hook install throws", async () => {
    await withTempDataDir(async () => {
      promptMock.mockRejectedValue(new Error("EACCES: permission denied"));

      const result = await runCommand("project init", [
        "hook boom",
        "--description=Demo",
        "--path=/ws",
      ]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((result.data as InitData).slug).toBe("hook-boom");
      expect((result.data as InitData).claudeCodeHook).toBeNull();
    });
  });

  it("skips the offer without a --path (never writes into the cwd)", async () => {
    await withTempDataDir(async () => {
      const result = await runCommand("project init", ["hook nopath", "--description=Demo"]);

      expect(result.ok).toBe(true);
      expect(promptMock).not.toHaveBeenCalled();
    });
  });

  it("skips the offer for --json and non-TTY callers", async () => {
    await withTempDataDir(async () => {
      const jsonResult = await runCommand("project init", [
        "hook json",
        "--description=Demo",
        "--path=/ws",
        "--json",
      ]);
      expect(jsonResult.ok).toBe(true);

      process.stdout.isTTY = false;
      const pipedResult = await runCommand("project init", [
        "hook piped",
        "--description=Demo",
        "--path=/ws",
      ]);
      expect(pipedResult.ok).toBe(true);

      expect(promptMock).not.toHaveBeenCalled();
    });
  });

  it("respects ARCS_SKIP_HOOK_INSTALL=1", async () => {
    await withTempDataDir(async () => {
      process.env.ARCS_SKIP_HOOK_INSTALL = "1";

      const result = await runCommand("project init", [
        "hook skipped",
        "--description=Demo",
        "--path=/ws",
      ]);

      expect(result.ok).toBe(true);
      expect(promptMock).not.toHaveBeenCalled();
    });
  });
});
