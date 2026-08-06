// ---------------------------------------------------------------------------
// Tests for `arcs hooks status` and the `arcs web` bound-port mismatch warning
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { hookUrlMismatchWarning } from "../src/cli/commands/hooks.js";
import {
  DEFAULT_SERVER_URL,
  DEFAULT_WEB_HOST,
  DEFAULT_WEB_PORT,
} from "../src/utils/hook-contract.js";
import { PACKAGE_ROOT } from "../src/utils/paths.js";
import { runCommand } from "./helpers/cli-runner.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

/**
 * The bound address is the one thing the `arcs web` handler cannot produce
 * without opening a real socket, so the listener — and nothing else — is
 * stubbed. `startWebServer` is the module's only export this command uses, so
 * the factory replaces it outright rather than spreading the original: a future
 * import needing more from here fails loudly instead of silently.
 */
const boundAddress = vi.hoisted(() => ({ url: "", host: "", port: 0 }));

vi.mock("../src/web-server/index.js", () => ({
  startWebServer: async () => ({ ...boundAddress, close: async () => {} }),
}));

interface StatusData {
  installed: boolean;
  matchesCurrentSlug: boolean;
  matchedSlugs: string[];
  hookUrls: string[];
  hookScriptPath: string;
}

const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "SessionEnd", "Stop"] as const;

const HOOK_SCRIPT_PATH = resolve(PACKAGE_ROOT, "scripts", "claude-code-session-hook.mjs");

/** A port `arcs web` could plausibly fall back to — never the hook's default. */
const OTHER_PORT = DEFAULT_WEB_PORT + 1;
const OTHER_URL = `http://${DEFAULT_WEB_HOST}:${OTHER_PORT}`;

/** Appends to the root DAG so several projects can coexist in one temp dir. */
function seedProject(dir: string, slug: string): { projectDir: string; workspacePath: string } {
  const rootMetaPath = resolve(dir, "meta.json");
  const rootMeta = JSON.parse(readFileSync(rootMetaPath, "utf-8")) as {
    version: string;
    projects: unknown[];
  };
  rootMeta.projects.push({ id: slug, name: "Hook Status Test", status: "active", dependsOn: [] });
  writeFileSync(rootMetaPath, JSON.stringify(rootMeta), "utf-8");

  const workspacePath = resolve(dir, "workspaces", slug);
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

function hookCommand(slug: string, url: string = DEFAULT_SERVER_URL): string {
  return (
    `ARCS_HOOK_TOKEN=11111111-1111-4111-8111-111111111111 ARCS_HOOK_SLUG=${slug} ` +
    `ARCS_HOOK_URL=${url} node ${HOOK_SCRIPT_PATH}`
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
  url: string = DEFAULT_SERVER_URL,
): string {
  return writeSettings(
    workspacePath,
    `${JSON.stringify(
      {
        permissions: { allow: ["Bash(ls:*)"] },
        hooks: Object.fromEntries(
          events.map((event) => [
            event,
            [{ hooks: [{ type: "command", command: hookCommand(slug, url) }] }],
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
      expect(data.hookUrls).toEqual([]);
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
      // The baked URL is what the hook will actually POST to for the rest of
      // this install's life, regardless of where `arcs web` later binds.
      expect(data.hookUrls).toEqual([DEFAULT_SERVER_URL]);

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

      // Registered for this project, but only on one of the four events — a
      // half-wired bridge must not report as installed.
      expect(data.installed).toBe(false);
      expect(data.matchesCurrentSlug).toBe(true);
      expect(data.matchedSlugs).toEqual(["demo"]);
    });
  });

  it("treats a legacy 3-event install as not installed but still reports the slug", async () => {
    await withTempDataDir(async (dir) => {
      const { workspacePath } = seedProject(dir, "demo");
      seedInstalledHook(workspacePath, "demo", ["SessionStart", "UserPromptSubmit", "SessionEnd"]);

      const result = await runCommand("hooks status", ["demo"]);
      const data = (result as { ok: true; data: StatusData }).data;

      // A pre-Stop install lacks the Stop event — the bridge is incomplete and
      // must be re-installed. matchedSlugs stays populated so the caller still
      // sees which project the hook is wired to.
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
      expect(data.hookUrls).toEqual([]);
    });
  });

  it("reports a non-default baked URL, and every distinct one when they disagree", async () => {
    await withTempDataDir(async (dir) => {
      const { workspacePath } = seedProject(dir, "demo");
      writeSettings(
        workspacePath,
        JSON.stringify({
          hooks: Object.fromEntries(
            HOOK_EVENTS.map((event, index) => [
              event,
              [
                {
                  hooks: [
                    {
                      type: "command",
                      // The last event was re-pointed by hand; status must not
                      // pick a winner between the two.
                      command: hookCommand(
                        "demo",
                        index === HOOK_EVENTS.length - 1 ? OTHER_URL : DEFAULT_SERVER_URL,
                      ),
                    },
                  ],
                },
              ],
            ]),
          ),
        }),
      );

      const result = await runCommand("hooks status", ["demo"]);
      const data = (result as { ok: true; data: StatusData }).data;

      expect(data.installed).toBe(true);
      expect(data.hookUrls).toEqual([DEFAULT_SERVER_URL, OTHER_URL]);
    });
  });

  it("does not crash on a malformed or empty settings file", async () => {
    await withTempDataDir(async (dir) => {
      const { projectDir, workspacePath } = seedProject(dir, "demo");
      writeSettings(workspacePath, "{ this is not json,,, ");

      const malformed = await runCommand("hooks status", ["demo"]);
      expect(malformed.ok).toBe(true);
      expect((malformed as { ok: true; data: StatusData }).data.installed).toBe(false);
      expect((malformed as { ok: true; data: StatusData }).data.hookUrls).toEqual([]);

      writeSettings(workspacePath, "   ");
      const empty = await runCommand("hooks status", ["demo"]);
      expect(empty.ok).toBe(true);
      expect((empty as { ok: true; data: StatusData }).data.installed).toBe(false);
      expect((empty as { ok: true; data: StatusData }).data.hookUrls).toEqual([]);

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

/**
 * The warning `arcs web` prints post-listen. Exercised directly rather than
 * through `runCommand("web")` so no socket is bound: the input that matters is
 * the ACTUALLY-bound address, which the CLI hands over as a plain value.
 */
describe("hook URL vs. bound port mismatch warning", () => {
  it("names both the bound port and the baked hook port", async () => {
    await withTempDataDir(async (dir) => {
      const { workspacePath } = seedProject(dir, "demo");
      seedInstalledHook(workspacePath, "demo");

      const warning = await hookUrlMismatchWarning({
        host: DEFAULT_WEB_HOST,
        port: OTHER_PORT,
      });

      expect(warning).not.toBeNull();
      // Both addresses, in full — a warning that named only one leaves the user
      // guessing which side to change.
      expect(warning).toContain(OTHER_URL);
      expect(warning).toContain(DEFAULT_SERVER_URL);
      expect(warning).toContain(String(OTHER_PORT));
      expect(warning).toContain(String(DEFAULT_WEB_PORT));
      // ...and the project plus a runnable repair.
      expect(warning).toContain("demo");
      expect(warning).toContain(`arcs hooks install-claude-code demo --url ${OTHER_URL} --write`);
    });
  });

  it("names every project whose hook disagrees, in one warning", async () => {
    await withTempDataDir(async (dir) => {
      const alpha = seedProject(dir, "alpha");
      const beta = seedProject(dir, "beta");
      seedInstalledHook(alpha.workspacePath, "alpha");
      const betaUrl = `http://${DEFAULT_WEB_HOST}:${DEFAULT_WEB_PORT + 2}`;
      seedInstalledHook(beta.workspacePath, "beta", HOOK_EVENTS, betaUrl);

      const warning = await hookUrlMismatchWarning({
        host: DEFAULT_WEB_HOST,
        port: OTHER_PORT,
      });

      expect(warning).toContain(`${DEFAULT_SERVER_URL}   (project alpha)`);
      expect(warning).toContain(`${betaUrl}   (project beta)`);
      // One warning, not one per project.
      expect(warning?.split("arcs web is listening on").length).toBe(2);
    });
  });

  it("stays silent when the bound port matches the baked URL", async () => {
    await withTempDataDir(async (dir) => {
      const { workspacePath } = seedProject(dir, "demo");
      seedInstalledHook(workspacePath, "demo");

      expect(
        await hookUrlMismatchWarning({ host: DEFAULT_WEB_HOST, port: DEFAULT_WEB_PORT }),
      ).toBeNull();
    });
  });

  it("stays silent when a loopback alias is bound on the hook's own port", async () => {
    await withTempDataDir(async (dir) => {
      const { workspacePath } = seedProject(dir, "demo");
      seedInstalledHook(workspacePath, "demo");

      // Host spellings are not compared: warning here would be noise, and the
      // port — the difference that actually refuses connections — matches.
      expect(await hookUrlMismatchWarning({ host: "::1", port: DEFAULT_WEB_PORT })).toBeNull();
    });
  });

  it("stays silent when no hook is installed", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "demo");

      expect(await hookUrlMismatchWarning({ host: DEFAULT_WEB_HOST, port: OTHER_PORT })).toBeNull();
    });
  });

  it("stays silent when the settings file is malformed, empty, or not an object", async () => {
    await withTempDataDir(async (dir) => {
      const { workspacePath } = seedProject(dir, "demo");

      for (const raw of ["{ this is not json,,, ", "   ", "[]", '"a string"']) {
        writeSettings(workspacePath, raw);
        expect(
          await hookUrlMismatchWarning({ host: DEFAULT_WEB_HOST, port: OTHER_PORT }),
        ).toBeNull();
      }
    });
  });

  it("stays silent when the hook command carries no parsable ARCS_HOOK_URL", async () => {
    await withTempDataDir(async (dir) => {
      const { workspacePath } = seedProject(dir, "demo");

      for (const url of ["not-a-url", "://:::"]) {
        seedInstalledHook(workspacePath, "demo", HOOK_EVENTS, url);
        expect(
          await hookUrlMismatchWarning({ host: DEFAULT_WEB_HOST, port: OTHER_PORT }),
        ).toBeNull();
      }

      // Nor when the assignment is missing outright.
      writeSettings(
        workspacePath,
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                hooks: [
                  { type: "command", command: `ARCS_HOOK_SLUG=demo node ${HOOK_SCRIPT_PATH}` },
                ],
              },
            ],
          },
        }),
      );
      expect(await hookUrlMismatchWarning({ host: DEFAULT_WEB_HOST, port: OTHER_PORT })).toBeNull();
    });
  });

  it("stays silent when the project has no workspace path", async () => {
    await withTempDataDir(async (dir) => {
      const { projectDir } = seedProject(dir, "demo");
      writeFileSync(
        resolve(projectDir, "meta.json"),
        JSON.stringify({ id: "demo", name: "Hook Status Test", createdAt: "2026-01-01" }),
        "utf-8",
      );

      expect(await hookUrlMismatchWarning({ host: DEFAULT_WEB_HOST, port: OTHER_PORT })).toBeNull();
    });
  });

  it("stays silent when the root DAG is missing or unreadable", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "demo");
      const rootMetaPath = resolve(dir, "meta.json");

      writeFileSync(rootMetaPath, "{{{ not json", "utf-8");
      expect(await hookUrlMismatchWarning({ host: DEFAULT_WEB_HOST, port: OTHER_PORT })).toBeNull();

      rmSync(rootMetaPath);
      expect(await hookUrlMismatchWarning({ host: DEFAULT_WEB_HOST, port: OTHER_PORT })).toBeNull();
    });
  });

  it("brackets an IPv6 bound host so the printed URL is valid", async () => {
    await withTempDataDir(async (dir) => {
      const { workspacePath } = seedProject(dir, "demo");
      seedInstalledHook(workspacePath, "demo");

      const warning = await hookUrlMismatchWarning({ host: "::1", port: OTHER_PORT });

      expect(warning).toContain(`http://[::1]:${OTHER_PORT}`);
    });
  });
});

/**
 * Everything above tests the helper. A helper nobody calls warns nobody, and
 * `arcs web` is its only caller — deleting the three lines in
 * src/cli/commands/web.ts that invoke it leaves every test above green. So this
 * drives the real command through the registry: real handler, real helper, real
 * stderr write. Only the socket is faked.
 */
describe("arcs web mismatch-warning call site", () => {
  it("prints the warning to stderr when the bound port is not the hook's", async () => {
    await withTempDataDir(async (dir) => {
      const { workspacePath } = seedProject(dir, "demo");
      seedInstalledHook(workspacePath, "demo");

      // The hook's own port is REQUESTED, and the listener comes up somewhere
      // else — what a taken port or an explicit `--port 0` produces. A handler
      // that checked `params.port` instead of the bound address would see no
      // mismatch at all here, and fail this test.
      boundAddress.url = OTHER_URL;
      boundAddress.host = DEFAULT_WEB_HOST;
      boundAddress.port = OTHER_PORT;

      const stderr: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        stderr.push(args.map(String).join(" "));
      });

      const result = await runCommand("web", [
        "--port",
        String(DEFAULT_WEB_PORT),
        "--no-open",
      ]).finally(() => {
        spy.mockRestore();
      });

      expect(result.ok).toBe(true);

      // Written, not merely returned — the banner is a separate stderr call, so
      // the warning has to be found among them rather than assumed.
      const warning = stderr.find((line) => line.includes("session bridge"));
      expect(warning).toBeDefined();
      expect(warning).toContain(OTHER_URL);
      expect(warning).toContain(DEFAULT_SERVER_URL);
      expect(warning).toContain(`arcs hooks install-claude-code demo --url ${OTHER_URL} --write`);
    });
  });
});
