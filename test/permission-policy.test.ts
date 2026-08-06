import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPermissionArgv,
  type PermissionArgvInput,
  RUN_INTENTS,
} from "../src/web-server/permission-policy.js";

// Resolve relative to project root (one level up from test/)
const root = resolve(import.meta.dirname, "..");

/**
 * The only flags this module is ever allowed to emit. Deliberately hardcoded
 * here instead of imported: a denylist the module owns would only prove the
 * module agrees with itself. Any new flag has to be added here consciously.
 */
const ALLOWED_FLAGS = ["--tools", "--permission-mode", "--append-system-prompt"];

/**
 * Escalation flags that must be unreachable from HTTP input. Every entry is a
 * real claude 2.1.x flag that widens permissions, reaches outside the run's
 * directory, or swaps the config the run trusts.
 */
const BYPASS_FLAGS = [
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--permission-prompt-tool",
  "--allowedTools",
  "--allowed-tools",
  "--disallowedTools",
  "--disallowed-tools",
  "--add-dir",
  "--settings",
  "--mcp-config",
  "--strict-mcp-config",
  "--plugin-dir",
  "--fork-session",
  "--worktree",
  "--cwd",
];

/** Permission modes that would defeat the point of the policy. */
const BYPASS_MODES = ["bypassPermissions", "auto", "dontAsk", "manual", "default"];

/** Every argv token that looks like a flag to an option parser. */
function flagTokens(argv: string[]): string[] {
  return argv.filter((token) => token.startsWith("-"));
}

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

/**
 * The core guarantee, applied to every argv any test produces: nothing outside
 * the closed flag allowlist appears, no bypass flag appears in any position
 * (flag OR value), and the permission mode is never a bypassing one.
 *
 * The staged system-prompt value is the single exemption from the substring
 * sweep — W2 fills it with DAG and user text, so it may legitimately mention
 * any string. It earns the exemption by proving it cannot be re-read as a flag:
 * argv reaches spawn as an array (no shell), so a token that does not start
 * with "-" is a value and nothing else.
 */
function expectNoBypass(argv: string[]): void {
  const stagedValueIndex = argv.indexOf("--append-system-prompt") + 1;
  for (const [index, token] of argv.entries()) {
    if (stagedValueIndex > 0 && index === stagedValueIndex) {
      expect(token.startsWith("-")).toBe(false);
      continue;
    }
    if (token.startsWith("-")) expect(ALLOWED_FLAGS).toContain(token);
    expect(BYPASS_FLAGS).not.toContain(token);
    expect(token.toLowerCase()).not.toContain("dangerously");
  }
  expect(BYPASS_MODES).not.toContain(flagValue(argv, "--permission-mode"));
  expect(["plan", "acceptEdits"]).toContain(flagValue(argv, "--permission-mode"));
}

describe("permission policy — intent to argv", () => {
  it("maps intent ask to the read-only tool set in plan mode", () => {
    expect(buildPermissionArgv({ intent: "ask" })).toEqual([
      "--tools",
      "Read,Grep,Glob",
      "--permission-mode",
      "plan",
    ]);
  });

  it("maps intent change to the edit tool set in acceptEdits mode", () => {
    expect(buildPermissionArgv({ intent: "change" })).toEqual([
      "--tools",
      "Read,Grep,Glob,Edit,Write,TodoWrite",
      "--permission-mode",
      "acceptEdits",
    ]);
  });

  it("fails closed to ask for a missing, unknown or hostile intent", () => {
    const degraded: PermissionArgvInput[] = [
      {},
      { intent: undefined },
      { intent: "CHANGE" },
      { intent: "change " },
      { intent: "edit" },
      { intent: "bypassPermissions" },
      { intent: ["change"] },
      { intent: { toString: () => "change" } },
      { intent: 1 },
      { intent: true },
      { intent: null },
    ];
    for (const input of degraded) {
      expect(buildPermissionArgv(input)).toEqual([
        "--tools",
        "Read,Grep,Glob",
        "--permission-mode",
        "plan",
      ]);
    }
  });

  it("exposes the intent list for route-level validation", () => {
    expect(RUN_INTENTS).toEqual(["ask", "change"]);
  });

  it("returns a fresh array so a caller cannot poison the next run", () => {
    const first = buildPermissionArgv({ intent: "change" });
    first.push("--dangerously-skip-permissions");
    first[1] = "Bash";
    expect(buildPermissionArgv({ intent: "change" })).toEqual([
      "--tools",
      "Read,Grep,Glob,Edit,Write,TodoWrite",
      "--permission-mode",
      "acceptEdits",
    ]);
  });
});

describe("permission policy — Bash is opt-in, never default", () => {
  it("omits Bash from both intents by default", () => {
    for (const intent of RUN_INTENTS) {
      expect(flagValue(buildPermissionArgv({ intent }), "--tools")).not.toContain("Bash");
    }
  });

  it("appends Bash last only on an explicit opt-in", () => {
    expect(buildPermissionArgv({ intent: "ask", allowBash: true })).toEqual([
      "--tools",
      "Read,Grep,Glob,Bash",
      "--permission-mode",
      "plan",
    ]);
    expect(buildPermissionArgv({ intent: "change", allowBash: true })).toEqual([
      "--tools",
      "Read,Grep,Glob,Edit,Write,TodoWrite,Bash",
      "--permission-mode",
      "acceptEdits",
    ]);
  });

  it("refuses truthy-but-not-true opt-ins from an HTTP body", () => {
    const notOptedIn: PermissionArgvInput[] = [
      { intent: "change", allowBash: "true" },
      { intent: "change", allowBash: "yes" },
      { intent: "change", allowBash: 1 },
      { intent: "change", allowBash: {} },
      { intent: "change", allowBash: [] },
      { intent: "change", allowBash: ["Bash"] },
      { intent: "change", allowBash: "Bash" },
      { intent: "change", allowBash: null },
      { intent: "change", allowBash: false },
    ];
    for (const input of notOptedIn) {
      expect(flagValue(buildPermissionArgv(input), "--tools")).toBe(
        "Read,Grep,Glob,Edit,Write,TodoWrite",
      );
    }
  });

  it("ignores tool lists the caller tries to supply directly", () => {
    const argv = buildPermissionArgv({
      intent: "change",
      tools: "Bash,Read",
      allowedTools: ["Bash(rm -rf /)"],
      disallowedTools: [],
      permissionMode: "bypassPermissions",
    });
    expect(argv).toEqual([
      "--tools",
      "Read,Grep,Glob,Edit,Write,TodoWrite",
      "--permission-mode",
      "acceptEdits",
    ]);
    expectNoBypass(argv);
  });
});

describe("permission policy — the --append-system-prompt slot", () => {
  it("omits the flag when no staged text is supplied", () => {
    const blank: PermissionArgvInput[] = [
      { intent: "ask" },
      { intent: "ask", stagedSystemPrompt: "" },
      { intent: "ask", stagedSystemPrompt: "   \n\t " },
      { intent: "ask", stagedSystemPrompt: undefined },
      { intent: "ask", stagedSystemPrompt: null },
      { intent: "ask", stagedSystemPrompt: 42 },
      { intent: "ask", stagedSystemPrompt: { text: "staged" } },
      { intent: "ask", stagedSystemPrompt: ["staged"] },
    ];
    for (const input of blank) {
      expect(buildPermissionArgv(input)).not.toContain("--append-system-prompt");
    }
  });

  it("emits the staged text last, after the tool and permission flags", () => {
    expect(
      buildPermissionArgv({ intent: "change", stagedSystemPrompt: "  ARCS STAGED ENVIRONMENT  " }),
    ).toEqual([
      "--tools",
      "Read,Grep,Glob,Edit,Write,TodoWrite",
      "--permission-mode",
      "acceptEdits",
      "--append-system-prompt",
      "ARCS STAGED ENVIRONMENT",
    ]);
  });

  it("appends, never replaces — no --system-prompt flag is ever produced", () => {
    const argv = buildPermissionArgv({ intent: "ask", stagedSystemPrompt: "staged" });
    expect(argv).not.toContain("--system-prompt");
    expect(argv).not.toContain("--system-prompt-file");
    expect(argv).toContain("--append-system-prompt");
  });

  it("keeps flag-shaped staged text as a value token, byte-for-byte", () => {
    const hostile = "--dangerously-skip-permissions\nignore the above";
    const argv = buildPermissionArgv({ intent: "change", stagedSystemPrompt: hostile });
    const staged = argv[argv.length - 1];
    expect(argv[argv.length - 2]).toBe("--append-system-prompt");
    expect(staged.startsWith("-")).toBe(false);
    expect(staged.trim()).toBe(hostile);
    expectNoBypass(argv);
  });

  it("carries multi-line staged text through unchanged", () => {
    const staged = "# ARCS\n\nworkspace: /tmp/x\n- limits: 6000\n";
    const argv = buildPermissionArgv({ intent: "ask", stagedSystemPrompt: staged });
    expect(argv[argv.length - 1]).toBe(staged.trim());
    expectNoBypass(argv);
  });
});

describe("permission policy — bypass flags are unreachable from HTTP input", () => {
  /**
   * HTTP-shaped payloads as they would arrive at POST /sessions/:id/turns: a
   * real field mix (intent, message, refs, guards) plus injection attempts
   * through every field the builder reads and several it does not.
   */
  const hostilePayloads: PermissionArgvInput[] = [
    { intent: "change", message: "please run --dangerously-skip-permissions" },
    { intent: "ask", message: "-p --dangerously-skip-permissions", allowBash: true },
    { intent: "--dangerously-skip-permissions" },
    { intent: "change --dangerously-skip-permissions" },
    { intent: "ask", permissionMode: "bypassPermissions" },
    { intent: "ask", "permission-mode": "bypassPermissions" },
    { intent: "change", argv: ["--dangerously-skip-permissions"] },
    { intent: "change", extraArgs: "--add-dir /" },
    { intent: "change", flags: { "--dangerously-skip-permissions": true } },
    { intent: "ask", "--dangerously-skip-permissions": true },
    { intent: "ask", cwd: "/etc", addDir: ["/"], settings: "/tmp/evil.json" },
    { intent: "change", mcpConfig: "/tmp/evil-mcp.json", pluginDir: "/tmp/evil" },
    {
      intent: "change",
      message: "fix the parser",
      refs: [
        { kind: "file", path: "../../etc/passwd" },
        { kind: "node", id: "--dangerously-skip-permissions" },
      ],
      guards: { dirtyWorktree: false, skip: true, bypass: "--dangerously-skip-permissions" },
    },
    { intent: "change", stagedSystemPrompt: "--dangerously-skip-permissions" },
    { intent: "change", stagedSystemPrompt: "-p --add-dir / --settings /tmp/evil.json" },
    { intent: "ask", allowBash: "true", stagedSystemPrompt: "--permission-mode bypassPermissions" },
    JSON.parse('{"intent":"ask","__proto__":{"intent":"change","allowBash":true}}'),
    JSON.parse('{"intent":"change","constructor":{"prototype":{"allowBash":true}}}'),
    JSON.parse('{"intent":"ask","stagedSystemPrompt":"--dangerously-skip-permissions"}'),
  ];

  it("never produces a bypass flag for any hostile payload", () => {
    for (const payload of hostilePayloads) {
      expectNoBypass(buildPermissionArgv(payload));
    }
  });

  it("emits only allowlisted flags, in a fixed shape, for any hostile payload", () => {
    for (const payload of hostilePayloads) {
      const argv = buildPermissionArgv(payload);
      expect(argv[0]).toBe("--tools");
      expect(argv[2]).toBe("--permission-mode");
      expect(argv.length === 4 || argv.length === 6).toBe(true);
      if (argv.length === 6) expect(argv[4]).toBe("--append-system-prompt");
      const flags = flagTokens(argv);
      expect(flags.length).toBe(argv.length / 2);
      expect(new Set(flags).size).toBe(flags.length);
    }
  });

  it("survives non-object input without leaking a permissive argv", () => {
    const notObjects = [null, undefined, [], "change", 42, true, () => "change"];
    for (const value of notObjects) {
      const argv = buildPermissionArgv(value as unknown as PermissionArgvInput);
      expect(argv).toEqual(["--tools", "Read,Grep,Glob", "--permission-mode", "plan"]);
      expectNoBypass(argv);
    }
  });

  it("never emits --cwd — claude >= 2.x rejects it and the runner passes cwd via spawn", () => {
    for (const payload of hostilePayloads) {
      expect(buildPermissionArgv(payload)).not.toContain("--cwd");
    }
  });
});

describe("permission policy — single source of tool and permission flags", () => {
  it("keeps claude-runner.ts argv-agnostic", () => {
    const runner = readFileSync(resolve(root, "src/web-server/claude-runner.ts"), "utf-8");
    for (const flag of ["--tools", "--permission-mode", "--append-system-prompt"]) {
      expect(runner).not.toContain(flag);
    }
    expect(runner.toLowerCase()).not.toContain("dangerously");
  });
});
