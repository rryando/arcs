// ---------------------------------------------------------------------------
// Tests for `arcs hooks status`
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "../src/utils/paths.js";
import { runCommand } from "./helpers/cli-runner.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

interface StatusData {
  installed: boolean;
  matchesCurrentSlug: boolean;
  matchedSlugs: string[];
  hookScriptPath: string;
}

const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "SessionEnd"] as const;

const HOOK_SCRIPT_PATH = resolve(PACKAGE_ROOT, "scripts", "claude-code-session-hook.mjs");

function seedProject(dir: string, slug: string): { projectDir: string; workspacePath: string } {
  writeFileSync(
    resolve(dir, "meta.json"),
    JSON.stringify({
      version: "1.0",
      projects: [{ id: slug, name: "Hook Status Test", status: "active", dependsOn: [] }],
    }),
    "utf-8",
  );

  const workspacePath = resolve(dir, "workspace");
  mkdirSync(workspacePath, { recursive: true });

  const projectDir = resolve(dir, "projects", slug);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    resolve(projectDir, "meta.json"),
    JSON.stringify({
      id: slug,
      name: "Hook Status Test",
      description: "Test",
      createdAt: "2026-01-01T00:00:00.000Z",
      workspacePaths: [workspacePath],
    }),
    "utf-8",
  );

  return { projectDir, workspacePath };
}

function hookCommand(slug: string): string {
  return (
    `ARCS_HOOK_TOKEN=11111111-1111-4111-8111-111111111111 ARCS_HOOK_SLUG=${slug} ` +
    `ARCS_HOOK_URL=http://127.0.0.1:4173 node ${HOOK_SCRIPT_PATH}`
  );
}

function writeSettings(workspacePath: string, raw: string): string {
  const settingsPath = join(workspacePath, ".claude", "settings.local.json");
  mkdirSync(join(workspacePath, ".claude"), { recursive: true });
  writeFileSync(settingsPath, raw, "utf-8");
  return settingsPath;
}

function seedInstalledHook(
  workspacePath: string,
  slug: string,
  events: readonly string[] = HOOK_EVENTS,
): string {
  return writeSettings(
    workspacePath,
    `${JSON.stringify(
      {
        permissions: { allow: ["Bash(ls:*)"] },
        hooks: Object.fromEntries(
          events.map((event) => [
            event,
            [{ hooks: [{ type: "command", command: hookCommand(slug) }] }],
          ]),
        ),
      },
      null,
      2,
    )}\n`,
  );
}

/** The token file must be an inert bystander: status never provisions. */
function seedToken(projectDir: string): { path: string; content: string } {
  const path = resolve(projectDir, "hooks", "claude-code-token.json");
  const content = JSON.stringify(
    { token: "22222222-2222-4222-8222-222222222222", createdAt: "2026-01-01T00:00:00.000Z" },
    null,
    2,
  );
  mkdirSync(resolve(projectDir, "hooks"), { recursive: true });
  writeFileSync(path, content, "utf-8");
  return { path, content };
}

function tokenPath(projectDir: string): string {
  return resolve(projectDir, "hooks", "claude-code-token.json");
}

describe("hooks status", () => {
  it("reports not installed when the workspace has no settings.local.json", async () => {
    await withTempDataDir(async (dir) => {
      const { projectDir } = seedProject(dir, "demo");

      const result = await runCommand("hooks status", ["demo"]);

      expect(result.ok).toBe(true);
      const data = (result as { ok: true; data: StatusData }).data;

      expect(data.installed).toBe(false);
      expect(data.matchesCurrentSlug).toBe(false);
      expect(data.matchedSlugs).toEqual([]);
      expect(data.hookScriptPath).toBe(HOOK_SCRIPT_PATH);
      expect(existsSync(data.hookScriptPath)).toBe(true);

      // A status check must never provision — no token may appear.
      expect(existsSync(tokenPath(projectDir))).toBe(false);
    });
  });

  it("reports installed and slug-matched when every event runs the hook script", async () => {
    await withTempDataDir(async (dir) => {
      const { projectDir, workspacePath } = seedProject(dir, "demo");
      seedInstalledHook(workspacePath, "demo");
      const token = seedToken(projectDir);

      const result = await runCommand("hooks status", ["demo"]);

      expect(result.ok).toBe(true);
      const data = (result as { ok: true; data: StatusData }).data;

      expect(data.installed).toBe(true);
      expect(data.matchesCurrentSlug).toBe(true);
      expect(data.matchedSlugs).toEqual(["demo"]);

      // Regression guard: reading status must not rotate an already-working
      // hook's token (`provisionHookCommand`/`writeHookToken` never called).
      expect(readFileSync(token.path, "utf-8")).toBe(token.content);
    });
  });

  it("reports a hook registered for a different project", async () => {
    await withTempDataDir(async (dir) => {
      const { projectDir, workspacePath } = seedProject(dir, "demo");
      seedInstalledHook(workspacePath, "other-project");
      const token = seedToken(projectDir);

      const result = await runCommand("hooks status", ["demo"]);

      const data = (result as { ok: true; data: StatusData }).data;
      expect(data.installed).toBe(true);
      expect(data.matchesCurrentSlug).toBe(false);
      expect(data.matchedSlugs).toEqual(["other-project"]);

      expect(readFileSync(token.path, "utf-8")).toBe(token.content);
    });
  });

  it("treats a partial registration as not installed but still reports the slug", async () => {
    await withTempDataDir(async (dir) => {
      const { workspacePath } = seedProject(dir, "demo");
      seedInstalledHook(workspacePath, "demo", ["SessionStart"]);

      const result = await runCommand("hooks status", ["demo"]);
      const data = (result as { ok: true; data: StatusData }).data;

      // Registered for this project, but only on one of the three events — a
      // half-wired bridge must not report as installed.
      expect(data.installed).toBe(false);
      expect(data.matchesCurrentSlug).toBe(true);
      expect(data.matchedSlugs).toEqual(["demo"]);
    });
  });

  it("ignores hook entries belonging to other tools", async () => {
    await withTempDataDir(async (dir) => {
      const { workspacePath } = seedProject(dir, "demo");
      writeSettings(
        workspacePath,
        JSON.stringify({
          hooks: {
            SessionStart: [
              { hooks: [{ type: "command", command: "node /opt/other-tool/hook.mjs" }] },
            ],
          },
        }),
      );

      const result = await runCommand("hooks status", ["demo"]);
      const data = (result as { ok: true; data: StatusData }).data;

      expect(data.installed).toBe(false);
      expect(data.matchedSlugs).toEqual([]);
    });
  });

  it("does not crash on a malformed or empty settings file", async () => {
    await withTempDataDir(async (dir) => {
      const { projectDir, workspacePath } = seedProject(dir, "demo");
      writeSettings(workspacePath, "{ this is not json,,, ");

      const malformed = await runCommand("hooks status", ["demo"]);
      expect(malformed.ok).toBe(true);
      expect((malformed as { ok: true; data: StatusData }).data.installed).toBe(false);

      writeSettings(workspacePath, "   ");
      const empty = await runCommand("hooks status", ["demo"]);
      expect(empty.ok).toBe(true);
      expect((empty as { ok: true; data: StatusData }).data.installed).toBe(false);

      expect(existsSync(tokenPath(projectDir))).toBe(false);
    });
  });

  it("fails cleanly for an unknown project", async () => {
    await withTempDataDir(async () => {
      const result = await runCommand("hooks status", ["nosuchproject"]);

      expect(result.ok).toBe(false);
      expect((result as { ok: false; code: string }).code).toBe("project_not_found");
    });
  });
});
