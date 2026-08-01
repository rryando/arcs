// ---------------------------------------------------------------------------
// Tests for `arcs hooks install-claude-code`
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readHookToken } from "../src/utils/hook-token-store.js";
import { runCommand } from "./helpers/cli-runner.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

interface InstallData {
  project: string;
  token: string;
  hookScriptPath: string;
  serverUrl: string;
  events: string[];
  settingsSnippet: string;
  notes: string[];
}

function seedProject(dir: string, slug: string): string {
  writeFileSync(
    resolve(dir, "meta.json"),
    JSON.stringify({
      version: "1.0",
      projects: [{ id: slug, name: "Hook Test", status: "active", dependsOn: [] }],
    }),
    "utf-8",
  );

  const projectDir = resolve(dir, "projects", slug);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    resolve(projectDir, "meta.json"),
    JSON.stringify({
      id: slug,
      name: "Hook Test",
      description: "Test",
      createdAt: "2026-01-01T00:00:00.000Z",
      workspacePaths: [process.cwd()],
    }),
    "utf-8",
  );
  return projectDir;
}

describe("hooks install-claude-code", () => {
  it("persists a token and returns a paste-ready settings snippet", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = seedProject(dir, "demo");

      const result = await runCommand("hooks install-claude-code", ["demo"]);

      expect(result.ok).toBe(true);
      const data = (result as { ok: true; data: InstallData }).data;

      expect(data.project).toBe("demo");
      expect(data.token).toMatch(/^[0-9a-f-]{36}$/);
      expect(await readHookToken(projectDir)).toBe(data.token);
      expect(data.serverUrl).toBe("http://127.0.0.1:4173");
      expect(data.events).toEqual(["SessionStart", "UserPromptSubmit", "SessionEnd"]);

      // The script must actually exist where the snippet points, or the pasted
      // config silently fails at the user's next prompt.
      expect(data.hookScriptPath.endsWith("scripts/claude-code-session-hook.mjs")).toBe(true);
      expect(existsSync(data.hookScriptPath)).toBe(true);

      const snippet = JSON.parse(data.settingsSnippet) as {
        hooks: Record<string, [{ hooks: [{ type: string; command: string }] }]>;
      };
      expect(Object.keys(snippet.hooks)).toEqual(data.events);
      for (const event of data.events) {
        const entry = snippet.hooks[event][0].hooks[0];
        expect(entry.type).toBe("command");
        expect(entry.command).toBe(
          `ARCS_HOOK_TOKEN=${data.token} ARCS_HOOK_SLUG=demo ` +
            `ARCS_HOOK_URL=${data.serverUrl} node ${data.hookScriptPath}`,
        );
      }
      expect(data.notes.join(" ")).toMatch(/never edits those files/i);
    });
  });

  it("honours a custom server url and strips a trailing slash", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "demo");

      const result = await runCommand("hooks install-claude-code", [
        "demo",
        "--url",
        "http://127.0.0.1:9999/",
      ]);

      const data = (result as { ok: true; data: InstallData }).data;
      expect(data.serverUrl).toBe("http://127.0.0.1:9999");
      expect(data.settingsSnippet).toContain("ARCS_HOOK_URL=http://127.0.0.1:9999 ");
    });
  });

  it("rotates the token when rerun", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = seedProject(dir, "demo");

      const first = (await runCommand("hooks install-claude-code", ["demo"])) as {
        ok: true;
        data: InstallData;
      };
      const second = (await runCommand("hooks install-claude-code", ["demo"])) as {
        ok: true;
        data: InstallData;
      };

      expect(second.data.token).not.toBe(first.data.token);
      expect(await readHookToken(projectDir)).toBe(second.data.token);
    });
  });

  it("writes nothing outside the project's own data directory", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = seedProject(dir, "demo");
      const settingsPath = resolve(process.cwd(), ".claude", "settings.local.json");
      const settingsBefore = existsSync(settingsPath) ? readFileSync(settingsPath, "utf-8") : null;

      await runCommand("hooks install-claude-code", ["demo"]);

      // Consent precedent: ARCS writes inside $ARCS_DATA only, never into a
      // user's agent configuration.
      expect(existsSync(resolve(dir, ".claude"))).toBe(false);
      expect(existsSync(settingsPath) ? readFileSync(settingsPath, "utf-8") : null).toBe(
        settingsBefore,
      );
      expect(existsSync(resolve(projectDir, "hooks", "claude-code-token.json"))).toBe(true);
    });
  });

  it("fails cleanly for an unknown project", async () => {
    await withTempDataDir(async () => {
      const result = await runCommand("hooks install-claude-code", ["nosuchproject"]);

      expect(result.ok).toBe(false);
      expect((result as { ok: false; code: string }).code).toBe("project_not_found");
    });
  });
});
