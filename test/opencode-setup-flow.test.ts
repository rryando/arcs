import * as childProcess from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runSetup } from "../src/cli/setup.js";
import { withTempHomeDir } from "./helpers/temp-home-dir.js";

vi.mock("@clack/prompts", () => {
  const confirm = vi.fn();
  const note = vi.fn();
  const text = vi.fn();
  const multiselect = vi.fn();
  const select = vi.fn();

  return {
    intro: vi.fn(),
    outro: vi.fn(),
    note,
    cancel: vi.fn(),
    isCancel: () => false,
    spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
    log: {
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      step: vi.fn(),
      message: vi.fn(),
    },
    confirm,
    text,
    multiselect,
    select,
    __confirm: confirm,
    __note: note,
    __text: text,
    __multiselect: multiselect,
    __select: select,
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawnSync: vi.fn(actual.spawnSync),
    execSync: vi.fn(actual.execSync),
  };
});

vi.mock("../src/cli/bundle-installer.js", () => ({
  detectArcsBundleInstall: vi.fn(() => ({ state: "absent" })),
  installArcsBundle: vi.fn(() => ({
    status: "installed",
    summary: "Installed bundled ARCS skills",
  })),
}));

describe("OpenCode setup flow", () => {
  beforeEach(async () => {
    const prompts = await import("@clack/prompts");
    const installer = await import("../src/cli/bundle-installer.js");

    vi.mocked((prompts as any).__confirm).mockReset();
    vi.mocked((prompts as any).__note).mockReset();
    vi.mocked((prompts as any).__text).mockReset();
    vi.mocked((prompts as any).__multiselect).mockReset();
    // text prompts return empty strings by default (model config)
    vi.mocked((prompts as any).__text).mockResolvedValue("");
    vi.mocked((prompts as any).__multiselect).mockResolvedValue(["opencode"]);
    const actualChildProcess =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    vi.mocked(childProcess.spawnSync).mockReset();
    // Fail-closed default: external binaries and installers must never execute
    // for real from these tests. Individual tests override as needed.
    vi.mocked(childProcess.spawnSync).mockImplementation(((cmd: any, args: any, options: any) => {
      if (cmd === "rtk" || cmd === "codegraph" || cmd === "sh" || cmd === "npm" || cmd === "brew") {
        return { status: 1, stdout: "", stderr: "" } as any;
      }
      return (actualChildProcess.spawnSync as any)(cmd, args, options);
    }) as any);
    vi.mocked(childProcess.execSync).mockReset();
    // Simulate opencode being installed/on PATH so the environment-detection
    // gate in runSetup() passes regardless of the host (CI has neither binary).
    // rtk/codegraph detection throws (= not installed) so setup-flow stays
    // host-independent; individual tests override as needed.
    vi.mocked(childProcess.execSync).mockImplementation(((cmd: any, ...rest: any[]) => {
      if (typeof cmd === "string" && cmd.includes("which opencode")) {
        return "/usr/local/bin/opencode\n" as any;
      }
      if (typeof cmd === "string" && cmd.includes("which claude")) {
        return "/usr/local/bin/claude\n" as any;
      }
      if (typeof cmd === "string" && (cmd.includes("rtk") || cmd.includes("codegraph"))) {
        throw new Error("binary not installed in tests");
      }
      return (actualChildProcess.execSync as any)(cmd, ...rest);
    }) as any);
    vi.mocked(installer.detectArcsBundleInstall).mockReset();
    vi.mocked(installer.installArcsBundle).mockReset();
    vi.mocked(installer.detectArcsBundleInstall).mockReturnValue({
      state: "absent",
    } as any);
    vi.mocked(installer.installArcsBundle).mockReturnValue({
      status: "installed",
      summary: "Installed bundled ARCS skills",
    } as any);
  });

  it("installs bundled ARCS skills during init when user confirms setup", async () => {
    const prompts = await import("@clack/prompts");
    const installer = await import("../src/cli/bundle-installer.js");

    vi.mocked((prompts as any).__confirm)
      .mockResolvedValueOnce(false) // customizeAgents
      .mockResolvedValueOnce(true); // register agent

    await withTempHomeDir(async () => {
      await runSetup("config");
      expect(installer.installArcsBundle).toHaveBeenCalledWith({
        autoConfirmReplacement: false,
      });
    });
  });

  it("skips bundled ARCS skills install when the user declines OpenCode agent registration", async () => {
    const prompts = await import("@clack/prompts");
    const installer = await import("../src/cli/bundle-installer.js");

    vi.mocked((prompts as any).__confirm)
      .mockResolvedValueOnce(false) // customizeAgents
      .mockResolvedValueOnce(false); // decline agent registration

    await withTempHomeDir(async () => {
      await runSetup("init");
      expect(installer.installArcsBundle).not.toHaveBeenCalled();
      expect((prompts as any).__note).toHaveBeenCalledWith(
        expect.stringContaining("declined ARCS Orchestrator registration"),
        "OpenCode ARCS Bundle",
      );
    });
  });

  it("asks before replacing a foreign OpenCode ARCS bundle install during init", async () => {
    const prompts = await import("@clack/prompts");
    const installer = await import("../src/cli/bundle-installer.js");

    vi.mocked(installer.detectArcsBundleInstall).mockReturnValue({
      state: "foreign-existing",
    } as any);
    vi.mocked((prompts as any).__confirm)
      .mockResolvedValueOnce(false) // customizeAgents
      .mockResolvedValueOnce(true) // register agent
      .mockResolvedValueOnce(true); // replace ARCS Bundle

    await withTempHomeDir(async () => {
      await runSetup("init");
      expect(installer.installArcsBundle).toHaveBeenCalledWith({
        autoConfirmReplacement: true,
      });
    });
  });

  it("asks before replacing a foreign OpenCode ARCS bundle install during config", async () => {
    const prompts = await import("@clack/prompts");
    const installer = await import("../src/cli/bundle-installer.js");

    vi.mocked(installer.detectArcsBundleInstall).mockReturnValue({
      state: "foreign-existing",
    } as any);
    vi.mocked((prompts as any).__confirm)
      .mockResolvedValueOnce(false) // customizeAgents
      .mockResolvedValueOnce(true) // register agent
      .mockResolvedValueOnce(true); // replace ARCS Bundle

    await withTempHomeDir(async () => {
      await runSetup("config");
      expect(installer.installArcsBundle).toHaveBeenCalledWith({
        autoConfirmReplacement: true,
      });
    });
  });

  it("skips replacement when the user declines foreign install takeover", async () => {
    const prompts = await import("@clack/prompts");
    const installer = await import("../src/cli/bundle-installer.js");

    vi.mocked(installer.detectArcsBundleInstall).mockReturnValue({
      state: "foreign-existing",
    } as any);
    vi.mocked((prompts as any).__confirm)
      .mockResolvedValueOnce(false) // customizeAgents
      .mockResolvedValueOnce(true) // register agent
      .mockResolvedValueOnce(false); // decline ARCS Bundle

    await withTempHomeDir(async () => {
      await runSetup("init");
      expect(installer.installArcsBundle).not.toHaveBeenCalled();
      expect((prompts as any).__note).toHaveBeenCalledWith(
        expect.stringContaining("Skipped OpenCode bundled ARCS Bundle install"),
        "OpenCode ARCS Bundle",
      );
    });
  });

  it("sets default_agent even when agent already configured (config mode)", async () => {
    const prompts = await import("@clack/prompts");
    const { readFileSync } = await import("node:fs");

    vi.mocked((prompts as any).__confirm).mockResolvedValueOnce(false); // customizeAgents — agent already present, no prompts

    await withTempHomeDir(async (homeDir) => {
      const configFile = resolve(homeDir, ".config", "opencode", "opencode.json");
      // Pre-populate config: agent already present, but missing default_agent
      writeFileSync(
        configFile,
        JSON.stringify(
          {
            agent: { "ARCS Orchestrator": { mode: "primary", prompt: "old-prompt" } },
          },
          null,
          2,
        ),
      );

      await runSetup("config");

      const updated = JSON.parse(readFileSync(configFile, "utf-8")) as Record<string, unknown>;
      // default_agent must now be set even though it was absent before
      expect(updated.default_agent).toBe("ARCS Orchestrator");
    });
  });

  it("re-applies agent entry even when already configured (config mode, stale prompt)", async () => {
    const prompts = await import("@clack/prompts");
    const { readFileSync } = await import("node:fs");

    vi.mocked((prompts as any).__confirm).mockResolvedValueOnce(false); // customizeAgents — both already present, no extra prompts

    await withTempHomeDir(async (homeDir) => {
      const configFile = resolve(homeDir, ".config", "opencode", "opencode.json");
      // Pre-populate: agent already registered with stale prompt, no default_agent
      writeFileSync(
        configFile,
        JSON.stringify(
          {
            mcp: {
              arcs: { type: "local", command: ["node", "/some/path/index.js"], enabled: true },
            },
            agent: { "ARCS Orchestrator": { mode: "primary", prompt: "stale-prompt-text" } },
          },
          null,
          2,
        ),
      );

      await runSetup("config");

      const updated = JSON.parse(readFileSync(configFile, "utf-8")) as Record<string, unknown>;
      // default_agent must now be set
      expect(updated.default_agent).toBe("ARCS Orchestrator");
      // Agent prompt should be updated to the current template value
      const agents = updated.agent as Record<string, unknown>;
      const arcsAgent = agents?.["ARCS Orchestrator"] as Record<string, unknown>;
      expect(arcsAgent?.prompt).not.toBe("stale-prompt-text");
    });
  });

  it("offers graph-explorer, not legacy explore, for light-tier customization", async () => {
    const prompts = await import("@clack/prompts");

    vi.mocked((prompts as any).__confirm).mockResolvedValueOnce(true); // customizeAgents
    vi.mocked((prompts as any).__text).mockImplementation(({ message }: { message: string }) => {
      if (message === "Heavy model (reasoning, synthesis)") return "heavy-model";
      if (message === "Standard model (general purpose)") return "standard-model";
      if (message === "Light/fast model (read-only, exploration)") return "light-model";
      if (message.includes("graph-explorer [light:")) return "graph-explorer-model";
      return "";
    });

    await withTempHomeDir(async (homeDir) => {
      const configFile = resolve(homeDir, ".config", "opencode", "opencode.json");
      writeFileSync(
        configFile,
        JSON.stringify({
          agent: {
            "ARCS Orchestrator": { mode: "primary", prompt: "old-prompt" },
            explore: { model: "legacy-model" },
            "graph-explorer": { model: "old-graph-model" },
          },
        }),
      );

      await runSetup("config");

      const agents = JSON.parse(readFileSync(configFile, "utf-8")).agent as Record<
        string,
        Record<string, unknown>
      >;
      expect(agents["graph-explorer"].model).toBe("graph-explorer-model");
      expect(agents.explore.model).toBe("legacy-model");
      expect((prompts as any).__text).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("graph-explorer [light:") }),
      );
      expect((prompts as any).__text).not.toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("explore [light:") }),
      );
    });
  });

  // Override rtk detection (beforeEach default = not installed) so the
  // wiring path runs; codegraph stays absent. spawnSync keeps the fail-closed
  // interception but lets rtk succeed.
  async function mockRtkAvailable() {
    const actualChildProcess =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");

    vi.mocked(childProcess.execSync).mockImplementation(((cmd: any, ...rest: any[]) => {
      if (typeof cmd === "string" && cmd.includes("which opencode")) {
        return "/usr/local/bin/opencode\n" as any;
      }
      if (typeof cmd === "string" && cmd.includes("which claude")) {
        return "/usr/local/bin/claude\n" as any;
      }
      if (typeof cmd === "string" && cmd.includes("rtk --version")) {
        return "rtk 1.0.0\n" as any;
      }
      if (typeof cmd === "string" && cmd.includes("which rtk")) {
        return "/usr/local/bin/rtk\n" as any;
      }
      if (typeof cmd === "string" && cmd.includes("codegraph")) {
        throw new Error("binary not installed in tests");
      }
      return (actualChildProcess.execSync as any)(cmd, ...rest);
    }) as any);

    vi.mocked(childProcess.spawnSync).mockImplementation(((cmd: any, args: any, options: any) => {
      if (cmd === "rtk") {
        return { status: 0, stdout: "", stderr: "" } as any;
      }
      if (cmd === "codegraph" || cmd === "sh" || cmd === "npm" || cmd === "brew") {
        return { status: 1, stdout: "", stderr: "" } as any;
      }
      return (actualChildProcess.spawnSync as any)(cmd, args, options);
    }) as any);
  }

  it("wires RTK for OpenCode + Claude Code when rtk is available and the user consents", async () => {
    const prompts = await import("@clack/prompts");
    await mockRtkAvailable();

    vi.mocked((prompts as any).__confirm)
      .mockResolvedValueOnce(false) // customizeAgents
      .mockResolvedValueOnce(true) // register agent
      .mockResolvedValueOnce(false) // decline codegraph install
      .mockResolvedValueOnce(true); // consent to RTK wiring (also covers Claude Code)

    await withTempHomeDir(async () => {
      await runSetup("init");
      expect(childProcess.spawnSync).toHaveBeenCalledWith(
        "rtk",
        ["init", "-g", "--opencode", "--auto-patch"],
        expect.any(Object),
      );
    });
  });

  it("skips RTK wiring when the user declines touching the unselected Claude Code config", async () => {
    const prompts = await import("@clack/prompts");
    await mockRtkAvailable();

    vi.mocked((prompts as any).__confirm)
      .mockResolvedValueOnce(false) // customizeAgents
      .mockResolvedValueOnce(true) // register agent
      .mockResolvedValueOnce(false) // decline codegraph install
      .mockResolvedValueOnce(false); // decline RTK wiring

    await withTempHomeDir(async () => {
      await runSetup("init");
      expect(childProcess.spawnSync).not.toHaveBeenCalledWith(
        "rtk",
        expect.anything(),
        expect.anything(),
      );
    });
  });

  it("shows RTK install pointer when rtk is missing and the user declines install", async () => {
    const prompts = await import("@clack/prompts");
    // beforeEach default applies: rtk and codegraph both absent, fail-closed spawns.

    vi.mocked((prompts as any).__confirm)
      .mockResolvedValueOnce(false) // customizeAgents
      .mockResolvedValueOnce(true) // register agent
      .mockResolvedValueOnce(false) // decline codegraph install
      .mockResolvedValueOnce(false); // decline RTK install

    await withTempHomeDir(async () => {
      await runSetup("init");
      expect((prompts as any).__note).toHaveBeenCalledWith(
        expect.stringContaining("github.com/rtk-ai/rtk"),
        "Optional: RTK",
      );
      expect(childProcess.spawnSync).not.toHaveBeenCalledWith(
        "rtk",
        expect.anything(),
        expect.anything(),
      );
    });
  });

  // Skipped: requires `select` mock on @clack/prompts which isn't currently wired
  it.skip("deploys sub-agents to Claude Code when user selects claudecode", async () => {
    const prompts = await import("@clack/prompts");

    // Mock multiselect to return ["claudecode"]
    vi.mocked((prompts as any).__multiselect).mockResolvedValue(["claudecode"]);
    // Mock confirm for "Deploy ARCS sub-agents to Claude Code?" to true
    vi.mocked((prompts as any).__confirm).mockResolvedValueOnce(true); // Deploy ARCS sub-agents to Claude Code?

    // Mock spawnSync to return a mock deployment result so setup.ts parses it successfully
    vi.mocked(childProcess.spawnSync).mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        source: "mock-source",
        destination: "mock-destination",
        filesAdded: ["file1"],
        filesChanged: [],
        filesRemoved: [],
      }),
      stderr: "",
    } as any);

    await withTempHomeDir(async () => {
      await runSetup("init");

      // Verify that spawnSync was called with the deploy script
      expect(childProcess.spawnSync).toHaveBeenCalledWith(
        "node",
        expect.arrayContaining([expect.stringContaining("deploy-claudecode-bundle.mjs")]),
        expect.any(Object),
      );
    });
  });
});
