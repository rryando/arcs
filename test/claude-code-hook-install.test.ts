// ---------------------------------------------------------------------------
// Tests for the consent-gated .claude/settings.local.json hook writer
// ---------------------------------------------------------------------------

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * Recorder for the syscalls that carry the mode guarantee.
 *
 * The repair-path window is an ORDER property — `writeFile`'s `mode` is a no-op
 * on an inode that already exists, so the only thing that keeps the fresh token
 * out of a 0644 inode is the chmod running BEFORE the write. A final-state
 * assertion cannot see that; the call sequence can. `vi.hoisted` because the
 * mock factory below is hoisted above every import.
 */
type FsCall = { op: "chmod" | "writeFile"; path: string; mode?: number; errno?: string };
const fsSpy = vi.hoisted(() => ({ calls: [] as FsCall[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  // Both wrappers delegate to the real implementation — this records the
  // sequence, it does not simulate a filesystem.
  const chmod = async (
    path: Parameters<typeof actual.chmod>[0],
    mode: Parameters<typeof actual.chmod>[1],
  ): Promise<void> => {
    const call: FsCall = { op: "chmod", path: String(path), mode: Number(mode) };
    fsSpy.calls.push(call);
    try {
      await actual.chmod(path, mode);
    } catch (err) {
      call.errno = (err as NodeJS.ErrnoException)?.code;
      throw err;
    }
  };
  const writeFile = async (
    file: Parameters<typeof actual.writeFile>[0],
    data: Parameters<typeof actual.writeFile>[1],
    options?: Parameters<typeof actual.writeFile>[2],
  ): Promise<void> => {
    const mode =
      typeof options === "object" && options !== null && options.mode !== undefined
        ? Number(options.mode)
        : undefined;
    fsSpy.calls.push({ op: "writeFile", path: String(file), mode });
    return actual.writeFile(file, data, options);
  };
  return { ...actual, default: { ...actual, chmod, writeFile }, chmod, writeFile };
});

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

/** The recorded calls that touched the settings file, in the order they ran. */
function recordSettingsCalls(settingsPath: string): FsCall[] {
  return fsSpy.calls.filter((c) => c.path === settingsPath);
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

  it("writes the token-bearing settings file owner-only on a fresh create", async () => {
    await withTempDataDir(async (dataDir) => {
      await withWorkspace(async (workspace) => {
        const projectDir = projectDirFor(dataDir, "demo");

        const result = await installClaudeCodeHook({
          workspacePath: workspace,
          projectDir,
          slug: "demo",
        });

        // The file is a second cleartext copy of the hook token, so its mode is
        // a control and not cosmetics.
        expect(readFileSync(result.settingsPath, "utf-8")).toContain(
          `ARCS_HOOK_TOKEN=${result.token}`,
        );
        expect(statSync(result.settingsPath).mode & 0o777).toBe(0o600);
      });
    });
  });

  it("repairs a pre-existing world-readable file, leaving .claude's own mode alone", async () => {
    await withTempDataDir(async (dataDir) => {
      await withWorkspace(async (workspace) => {
        const projectDir = projectDirFor(dataDir, "demo");
        const claudeDir = resolve(workspace, ".claude");
        const settingsPath = claudeSettingsLocalPath(workspace);
        mkdirSync(claudeDir, { recursive: true });
        writeFileSync(
          settingsPath,
          JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }),
          "utf-8",
        );
        // What an older ARCS install left behind under a default umask.
        chmodSync(settingsPath, 0o644);
        const dirModeBefore = statSync(claudeDir).mode & 0o777;

        await installClaudeCodeHook({ workspacePath: workspace, projectDir, slug: "demo" });

        // `writeFile`'s mode applies only at create and this write truncates the
        // inode already there, so the chmods are what narrow it.
        expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
        // `.claude` holds the user's other files — ARCS must not narrow it.
        expect(statSync(claudeDir).mode & 0o777).toBe(dirModeBefore);
        expect(readSettings(workspace).permissions).toEqual({ allow: ["Bash(ls)"] });
      });
    });
  });

  it("narrows a pre-existing file BEFORE the new token is written into it", async () => {
    await withTempDataDir(async (dataDir) => {
      await withWorkspace(async (workspace) => {
        const projectDir = projectDirFor(dataDir, "demo");
        const settingsPath = claudeSettingsLocalPath(workspace);
        mkdirSync(resolve(workspace, ".claude"), { recursive: true });
        writeFileSync(settingsPath, "{}", "utf-8");
        chmodSync(settingsPath, 0o644);

        fsSpy.calls.length = 0;
        await installClaudeCodeHook({ workspacePath: workspace, projectDir, slug: "demo" });

        // The order IS the control: a trailing chmod alone would leave the fresh
        // token sitting in the 0644 inode for the write plus an await hop.
        const calls = recordSettingsCalls(settingsPath);
        expect(calls.map((c) => `${c.op}:${c.mode?.toString(8)}`)).toEqual([
          "chmod:600",
          "writeFile:600",
          "chmod:600",
        ]);
        // The leading chmod really ran here — the file existed, so no ENOENT.
        expect(calls[0].errno).toBeUndefined();
        expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
        expect(readFileSync(settingsPath, "utf-8")).toContain("ARCS_HOOK_TOKEN=");
      });
    });
  });

  it("tolerates ENOENT from the pre-write chmod when there is no file yet", async () => {
    await withTempDataDir(async (dataDir) => {
      await withWorkspace(async (workspace) => {
        const projectDir = projectDirFor(dataDir, "demo");

        fsSpy.calls.length = 0;
        const result = await installClaudeCodeHook({
          workspacePath: workspace,
          projectDir,
          slug: "demo",
        });

        const calls = recordSettingsCalls(result.settingsPath);
        expect(calls.map((c) => c.op)).toEqual(["chmod", "writeFile", "chmod"]);
        // Nothing to narrow yet, and that must not fail the install: on this
        // path the create-mode is what makes the inode 0600 with no window.
        expect(calls[0].errno).toBe("ENOENT");
        expect(statSync(result.settingsPath).mode & 0o777).toBe(0o600);
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

        fsSpy.calls.length = 0;
        await expect(
          installClaudeCodeHook({ workspacePath: workspace, projectDir, slug: "demo" }),
        ).rejects.toThrow(/not valid JSON/);

        // Byte-for-byte untouched — the user's permissions block survives.
        expect(readFileSync(claudeSettingsLocalPath(workspace), "utf-8")).toBe(malformed);
        // And mode-untouched too: the pre-write chmod sits after the parse, so
        // an aborted install does not restat a file it refused to write.
        expect(recordSettingsCalls(claudeSettingsLocalPath(workspace))).toEqual([]);
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
