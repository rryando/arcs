// ---------------------------------------------------------------------------
// Tests for the consent-gated .claude/settings.local.json hook writer
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ClaudeSettings,
  claudeSettingsLocalPath,
  installClaudeCodeHook,
  mergeHookIntoSettings,
} from "../src/utils/claude-code-hook-install.js";
import { readHookToken } from "../src/utils/hook-token-store.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

interface SettingsFile {
  hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
  [key: string]: unknown;
}

const EVENTS = ["SessionStart", "UserPromptSubmit", "SessionEnd", "Stop"];

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = mkdtempSync(resolve(tmpdir(), "arcs-ws-"));
  try {
    await run(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function readSettings(workspace: string): SettingsFile {
  return JSON.parse(readFileSync(claudeSettingsLocalPath(workspace), "utf-8")) as SettingsFile;
}

function projectDirFor(dataDir: string, slug: string): string {
  const dir = resolve(dataDir, "projects", slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("installClaudeCodeHook", () => {
  it("creates .claude/settings.local.json with the hook under every event", async () => {
    await withTempDataDir(async (dataDir) => {
      await withWorkspace(async (workspace) => {
        const projectDir = projectDirFor(dataDir, "demo");

        const result = await installClaudeCodeHook({
          workspacePath: workspace,
          projectDir,
          slug: "demo",
        });

        expect(result.settingsPath).toBe(resolve(workspace, ".claude", "settings.local.json"));
        expect(result.events).toEqual(EVENTS);
        expect(await readHookToken(projectDir)).toBe(result.token);

        const settings = readSettings(workspace);
        expect(Object.keys(settings.hooks)).toEqual(EVENTS);
        for (const event of EVENTS) {
          expect(settings.hooks[event]).toHaveLength(1);
          const entry = settings.hooks[event][0].hooks[0];
          expect(entry.type).toBe("command");
          expect(entry.command).toBe(
            `ARCS_HOOK_TOKEN=${result.token} ARCS_HOOK_SLUG=demo ` +
              `ARCS_HOOK_URL=${result.serverUrl} node ${result.hookScriptPath}`,
          );
        }
      });
    });
  });

  it("preserves unrelated settings keys and a foreign hook entry in the same event", async () => {
    await withTempDataDir(async (dataDir) => {
      await withWorkspace(async (workspace) => {
        const projectDir = projectDirFor(dataDir, "demo");
        mkdirSync(resolve(workspace, ".claude"), { recursive: true });
        writeFileSync(
          claudeSettingsLocalPath(workspace),
          JSON.stringify(
            {
              permissions: { allow: ["Bash(npm run test)"] },
              hooks: {
                SessionStart: [{ hooks: [{ type: "command", command: "other-tool --start" }] }],
              },
            },
            null,
            2,
          ),
          "utf-8",
        );

        await installClaudeCodeHook({ workspacePath: workspace, projectDir, slug: "demo" });

        const settings = readSettings(workspace);
        expect(settings.permissions).toEqual({ allow: ["Bash(npm run test)"] });
        expect(settings.hooks.SessionStart).toHaveLength(2);
        expect(settings.hooks.SessionStart[0].hooks[0].command).toBe("other-tool --start");
        expect(settings.hooks.SessionStart[1].hooks[0].command).toContain("ARCS_HOOK_TOKEN=");
      });
    });
  });

  it("is idempotent by script path — a second run replaces, never duplicates", async () => {
    await withTempDataDir(async (dataDir) => {
      await withWorkspace(async (workspace) => {
        const projectDir = projectDirFor(dataDir, "demo");
        mkdirSync(resolve(workspace, ".claude"), { recursive: true });
        writeFileSync(
          claudeSettingsLocalPath(workspace),
          JSON.stringify({
            hooks: {
              SessionEnd: [{ hooks: [{ type: "command", command: "other-tool --end" }] }],
            },
          }),
          "utf-8",
        );

        const first = await installClaudeCodeHook({
          workspacePath: workspace,
          projectDir,
          slug: "demo",
        });
        // Re-install under a DIFFERENT slug: the workspace was reassigned to
        // another ARCS project, and the stale entry must still be replaced.
        const second = await installClaudeCodeHook({
          workspacePath: workspace,
          projectDir,
          slug: "renamed",
        });

        expect(second.token).not.toBe(first.token);

        const settings = readSettings(workspace);
        for (const event of EVENTS) {
          const arcsEntries = settings.hooks[event].filter((e) =>
            e.hooks.some((h) => h.command.includes(second.hookScriptPath)),
          );
          expect(arcsEntries).toHaveLength(1);
          expect(arcsEntries[0].hooks[0].command).toContain(`ARCS_HOOK_TOKEN=${second.token}`);
          expect(arcsEntries[0].hooks[0].command).toContain("ARCS_HOOK_SLUG=renamed");
        }
        // The foreign entry survived both runs, still first in its array.
        expect(settings.hooks.SessionEnd).toHaveLength(2);
        expect(settings.hooks.SessionEnd[0].hooks[0].command).toBe("other-tool --end");
      });
    });
  });

  it("aborts without writing when the existing settings file is malformed JSON", async () => {
    await withTempDataDir(async (dataDir) => {
      await withWorkspace(async (workspace) => {
        const projectDir = projectDirFor(dataDir, "demo");
        mkdirSync(resolve(workspace, ".claude"), { recursive: true });
        const malformed = '{\n  "permissions": { "allow": ["Bash(ls)"] },\n}';
        writeFileSync(claudeSettingsLocalPath(workspace), malformed, "utf-8");

        await expect(
          installClaudeCodeHook({ workspacePath: workspace, projectDir, slug: "demo" }),
        ).rejects.toThrow(/not valid JSON/);

        // Byte-for-byte untouched — the user's permissions block survives.
        expect(readFileSync(claudeSettingsLocalPath(workspace), "utf-8")).toBe(malformed);
        // And no token was rotated, so any previously installed hook still works.
        expect(await readHookToken(projectDir)).toBeUndefined();
      });
    });
  });

  it("aborts when the existing settings file is JSON but not an object", async () => {
    await withTempDataDir(async (dataDir) => {
      await withWorkspace(async (workspace) => {
        const projectDir = projectDirFor(dataDir, "demo");
        mkdirSync(resolve(workspace, ".claude"), { recursive: true });
        writeFileSync(claudeSettingsLocalPath(workspace), "[1, 2, 3]", "utf-8");

        await expect(
          installClaudeCodeHook({ workspacePath: workspace, projectDir, slug: "demo" }),
        ).rejects.toThrow(/not an object/);
        expect(readFileSync(claudeSettingsLocalPath(workspace), "utf-8")).toBe("[1, 2, 3]");
      });
    });
  });

  it("treats an empty file as absent rather than malformed", async () => {
    await withTempDataDir(async (dataDir) => {
      await withWorkspace(async (workspace) => {
        const projectDir = projectDirFor(dataDir, "demo");
        mkdirSync(resolve(workspace, ".claude"), { recursive: true });
        writeFileSync(claudeSettingsLocalPath(workspace), "\n", "utf-8");

        const result = await installClaudeCodeHook({
          workspacePath: workspace,
          projectDir,
          slug: "demo",
        });
        expect(existsSync(result.settingsPath)).toBe(true);
        expect(Object.keys(readSettings(workspace).hooks)).toEqual(EVENTS);
      });
    });
  });

  it("honours a custom server url", async () => {
    await withTempDataDir(async (dataDir) => {
      await withWorkspace(async (workspace) => {
        const projectDir = projectDirFor(dataDir, "demo");

        const result = await installClaudeCodeHook({
          workspacePath: workspace,
          projectDir,
          slug: "demo",
          serverUrl: "http://127.0.0.1:9999/",
        });

        expect(result.serverUrl).toBe("http://127.0.0.1:9999");
        expect(readSettings(workspace).hooks.SessionStart[0].hooks[0].command).toContain(
          "ARCS_HOOK_URL=http://127.0.0.1:9999 ",
        );
      });
    });
  });
});

describe("mergeHookIntoSettings", () => {
  const hook = {
    command: "TOKEN=x node /pkg/scripts/hook.mjs",
    hookScriptPath: "/pkg/scripts/hook.mjs",
  };

  it("leaves entries it does not understand exactly as found", () => {
    const settings = {
      hooks: { SessionStart: [{ matcher: "*" } as unknown as { hooks: [] }] },
    } as ClaudeSettings;

    const merged = mergeHookIntoSettings(settings, hook);

    expect(merged.hooks?.SessionStart?.[0]).toEqual({ matcher: "*" });
    expect(merged.hooks?.SessionStart).toHaveLength(2);
  });

  it("strips only the ARCS command from a mixed matcher entry", () => {
    const settings: ClaudeSettings = {
      hooks: {
        SessionStart: [
          {
            matcher: "*",
            hooks: [
              { type: "command", command: "OLD=1 node /pkg/scripts/hook.mjs" },
              { type: "command", command: "other-tool" },
            ],
          },
        ],
      },
    };

    const merged = mergeHookIntoSettings(settings, hook);

    expect(merged.hooks?.SessionStart?.[0]).toEqual({
      matcher: "*",
      hooks: [{ type: "command", command: "other-tool" }],
    });
    expect(merged.hooks?.SessionStart).toHaveLength(2);
  });

  it("does not mutate the input settings object", () => {
    const settings: ClaudeSettings = { hooks: { SessionStart: [] } };
    mergeHookIntoSettings(settings, hook);
    expect(settings.hooks?.SessionStart).toEqual([]);
  });
});
