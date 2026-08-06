import * as childProcess from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    vi.mocked((prompts as any).__select).mockReset();
    // text prompts return empty strings by default (model config)
    vi.mocked((prompts as any).__text).mockResolvedValue("");
    // select prompts (model tiers, primary orchestrator) return an unrecognized
    // value by default, which leaves every default-picking path on its fallback
    vi.mocked((prompts as any).__select).mockResolvedValue("");
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

  it("makes the picked primary the OpenCode default agent", async () => {
    const prompts = await import("@clack/prompts");
    const PRIMARY_PROMPT = "Which ARCS primary should be the default in OpenCode?";

    vi.mocked((prompts as any).__confirm)
      .mockResolvedValueOnce(false) // customizeAgents
      .mockResolvedValueOnce(true) // register agents
      .mockResolvedValueOnce(false) // decline codegraph install
      .mockResolvedValueOnce(false); // decline RTK install
    vi.mocked((prompts as any).__select).mockImplementation(({ message }: { message: string }) =>
      message === PRIMARY_PROMPT ? "arcs-flash" : "",
    );

    await withTempHomeDir(async (homeDir) => {
      await runSetup("init");

      expect((prompts as any).__select).toHaveBeenCalledWith(
        expect.objectContaining({ message: PRIMARY_PROMPT, initialValue: "arcs-orchestrate" }),
      );

      const configFile = resolve(homeDir, ".config", "opencode", "opencode.json");
      const config = JSON.parse(readFileSync(configFile, "utf-8")) as Record<string, unknown>;

      expect(config.default_agent).toBe("ARCS Flash");
      // All three primaries stay registered, in their fixed Tab-cycle order
      expect(Object.keys(config.agent as object).slice(0, 3)).toEqual([
        "ARCS Orchestrator",
        "ARCS Flash",
        "ARCS Caveman",
      ]);
    });
  });

  describe("re-run primary orchestrator selection (OpenCode already registered)", () => {
    const PRIMARY_PROMPT = "Which ARCS primary should be the default in OpenCode?";

    /**
     * Config with the ARCS agents already registered (so setup takes the
     * already-registered branch) and no model/small_model (so the model-reuse
     * fast path stays out of the way).
     */
    function writeRegistered(homeDir: string, defaultAgent?: string) {
      writeFileSync(
        resolve(homeDir, ".config", "opencode", "opencode.json"),
        JSON.stringify(
          {
            ...(defaultAgent ? { default_agent: defaultAgent } : {}),
            agent: {
              "ARCS Orchestrator": { mode: "primary", prompt: "old-prompt" },
              "ARCS Flash": { mode: "primary", prompt: "old-prompt" },
              "ARCS Caveman": { mode: "primary", prompt: "old-prompt" },
            },
          },
          null,
          2,
        ),
      );
    }

    /** Mirrors pressing Enter: the prompt resolves to whatever it pre-selected. */
    async function acceptPreSelectedPrimary() {
      const prompts = await import("@clack/prompts");
      vi.mocked((prompts as any).__select).mockImplementation(
        ({ message, initialValue }: { message: string; initialValue?: string }) =>
          message === PRIMARY_PROMPT ? initialValue : "",
      );
    }

    it("pre-selects the installed default so accepting it is a no-op", async () => {
      const prompts = await import("@clack/prompts");
      await acceptPreSelectedPrimary();

      vi.mocked((prompts as any).__confirm).mockResolvedValueOnce(false); // customizeAgents

      await withTempHomeDir(async (homeDir) => {
        const configFile = resolve(homeDir, ".config", "opencode", "opencode.json");
        writeRegistered(homeDir, "ARCS Flash");

        await runSetup("config");

        expect((prompts as any).__select).toHaveBeenCalledWith(
          expect.objectContaining({ message: PRIMARY_PROMPT, initialValue: "arcs-flash" }),
        );
        const updated = JSON.parse(readFileSync(configFile, "utf-8")) as Record<string, unknown>;
        expect(updated.default_agent).toBe("ARCS Flash");
      });
    });

    it("switches the default primary when the user picks a different one on a re-run", async () => {
      const prompts = await import("@clack/prompts");

      vi.mocked((prompts as any).__select).mockImplementation(({ message }: { message: string }) =>
        message === PRIMARY_PROMPT ? "arcs-orchestrate-caveman" : "",
      );
      vi.mocked((prompts as any).__confirm).mockResolvedValueOnce(false); // customizeAgents

      await withTempHomeDir(async (homeDir) => {
        const configFile = resolve(homeDir, ".config", "opencode", "opencode.json");
        writeRegistered(homeDir, "ARCS Orchestrator");

        await runSetup("config");

        expect((prompts as any).__select).toHaveBeenCalledWith(
          expect.objectContaining({ message: PRIMARY_PROMPT, initialValue: "arcs-orchestrate" }),
        );
        const updated = JSON.parse(readFileSync(configFile, "utf-8")) as Record<string, unknown>;
        expect(updated.default_agent).toBe("ARCS Caveman");
        // All three primaries stay registered, in their fixed Tab-cycle order
        expect(Object.keys(updated.agent as object).slice(0, 3)).toEqual([
          "ARCS Orchestrator",
          "ARCS Flash",
          "ARCS Caveman",
        ]);
      });
    });

    it("falls back to arcs-orchestrate when no default_agent is recorded", async () => {
      const prompts = await import("@clack/prompts");
      await acceptPreSelectedPrimary();

      vi.mocked((prompts as any).__confirm).mockResolvedValueOnce(false); // customizeAgents

      await withTempHomeDir(async (homeDir) => {
        writeRegistered(homeDir);

        await runSetup("config");

        expect((prompts as any).__select).toHaveBeenCalledWith(
          expect.objectContaining({ message: PRIMARY_PROMPT, initialValue: "arcs-orchestrate" }),
        );
      });
    });

    it("falls back to arcs-orchestrate when default_agent names a non-ARCS agent", async () => {
      const prompts = await import("@clack/prompts");
      await acceptPreSelectedPrimary();

      vi.mocked((prompts as any).__confirm).mockResolvedValueOnce(false); // customizeAgents

      await withTempHomeDir(async (homeDir) => {
        const configFile = resolve(homeDir, ".config", "opencode", "opencode.json");
        writeRegistered(homeDir, "build");

        await runSetup("config");

        expect((prompts as any).__select).toHaveBeenCalledWith(
          expect.objectContaining({ message: PRIMARY_PROMPT, initialValue: "arcs-orchestrate" }),
        );
        const updated = JSON.parse(readFileSync(configFile, "utf-8")) as Record<string, unknown>;
        expect(updated.default_agent).toBe("ARCS Orchestrator");
      });
    });
  });

  describe("reuse existing OpenCode config confirm", () => {
    const REUSE_MESSAGE = "Reuse the existing OpenCode model config?";
    const HEAVY_PROMPT = "Heavy model (reasoning, synthesis)";
    const STANDARD_PROMPT = "Standard model (general purpose)";
    const LIGHT_PROMPT = "Light/fast model (read-only, exploration)";
    const PRIMARY_PROMPT = "Which ARCS primary should be the default in OpenCode?";

    /** Config that satisfies every detection leg: parses, ARCS agent registered, all tiers filled. */
    function writeFullyConfigured(homeDir: string) {
      writeFileSync(
        resolve(homeDir, ".config", "opencode", "opencode.json"),
        JSON.stringify(
          {
            model: "provider/existing-model",
            small_model: "provider/existing-small",
            agent: { "ARCS Orchestrator": { mode: "primary", prompt: "old-prompt" } },
          },
          null,
          2,
        ),
      );
    }

    async function resetSelect() {
      const prompts = await import("@clack/prompts");
      vi.mocked((prompts as any).__select).mockReset();
      vi.mocked((prompts as any).__select).mockResolvedValue("");
    }

    it("offers reuse and skips every model prompt when the user accepts", async () => {
      const prompts = await import("@clack/prompts");
      const installer = await import("../src/cli/bundle-installer.js");
      await resetSelect();

      vi.mocked((prompts as any).__confirm)
        .mockResolvedValueOnce(true) // reuse existing config
        .mockResolvedValueOnce(false) // decline codegraph install
        .mockResolvedValueOnce(false); // decline RTK install

      await withTempHomeDir(async (homeDir) => {
        const configFile = resolve(homeDir, ".config", "opencode", "opencode.json");
        writeFullyConfigured(homeDir);

        await runSetup("config");

        // The confirm surfaces the detected values it will reuse
        expect((prompts as any).__confirm).toHaveBeenCalledWith(
          expect.objectContaining({
            message: expect.stringContaining(REUSE_MESSAGE),
            initialValue: true,
          }),
        );
        expect((prompts as any).__confirm).toHaveBeenCalledWith(
          expect.objectContaining({
            message: expect.stringContaining("provider/existing-model"),
          }),
        );
        expect((prompts as any).__confirm).toHaveBeenCalledWith(
          expect.objectContaining({
            message: expect.stringContaining("provider/existing-small"),
          }),
        );

        // No tier prompts, no per-agent customization prompt — the only select
        // is the primary-orchestrator pick, which a re-run must still offer.
        expect((prompts as any).__select).toHaveBeenCalledTimes(1);
        expect((prompts as any).__select).toHaveBeenCalledWith(
          expect.objectContaining({ message: PRIMARY_PROMPT }),
        );
        for (const message of [HEAVY_PROMPT, STANDARD_PROMPT, LIGHT_PROMPT]) {
          expect((prompts as any).__text).not.toHaveBeenCalledWith(
            expect.objectContaining({ message }),
          );
        }
        expect((prompts as any).__confirm).not.toHaveBeenCalledWith(
          expect.objectContaining({ message: "Customize model for individual agents?" }),
        );

        // Agent registration still ran, using the pre-fill-derived config
        expect(installer.installArcsBundle).toHaveBeenCalledWith({
          autoConfirmReplacement: false,
        });
        const updated = JSON.parse(readFileSync(configFile, "utf-8")) as Record<string, unknown>;
        expect(updated.default_agent).toBe("ARCS Orchestrator");
        expect(updated.model).toBe("provider/existing-model");
        expect(updated.small_model).toBe("provider/existing-small");
        const agents = updated.agent as Record<string, Record<string, unknown>>;
        expect(agents["ARCS Orchestrator"].model).toBe("provider/existing-model");
        expect(agents["ARCS Orchestrator"].prompt).not.toBe("old-prompt");
      });
    });

    it("falls through to the full model prompt sequence when the user declines reuse", async () => {
      const prompts = await import("@clack/prompts");
      await resetSelect();

      vi.mocked((prompts as any).__confirm)
        .mockResolvedValueOnce(false) // decline reuse
        .mockResolvedValueOnce(false) // customizeAgents
        .mockResolvedValueOnce(false) // decline codegraph install
        .mockResolvedValueOnce(false); // decline RTK install
      vi.mocked((prompts as any).__text).mockImplementation(({ message }: { message: string }) => {
        if (message === HEAVY_PROMPT) return "heavy-model";
        if (message === STANDARD_PROMPT) return "standard-model";
        if (message === LIGHT_PROMPT) return "light-model";
        return "";
      });

      await withTempHomeDir(async (homeDir) => {
        const configFile = resolve(homeDir, ".config", "opencode", "opencode.json");
        writeFullyConfigured(homeDir);

        await runSetup("config");

        // Reuse was offered and declined — the full sequence still runs
        expect((prompts as any).__confirm).toHaveBeenCalledWith(
          expect.objectContaining({ message: expect.stringContaining(REUSE_MESSAGE) }),
        );
        for (const message of [HEAVY_PROMPT, STANDARD_PROMPT, LIGHT_PROMPT]) {
          expect((prompts as any).__text).toHaveBeenCalledWith(
            expect.objectContaining({ message }),
          );
        }
        expect((prompts as any).__confirm).toHaveBeenCalledWith(
          expect.objectContaining({ message: "Customize model for individual agents?" }),
        );

        const updated = JSON.parse(readFileSync(configFile, "utf-8")) as Record<string, unknown>;
        expect(updated.model).toBe("standard-model");
        expect(updated.small_model).toBe("light-model");
      });
    });

    it("never offers reuse when the ARCS agent is not registered yet", async () => {
      const prompts = await import("@clack/prompts");
      await resetSelect();

      vi.mocked((prompts as any).__confirm)
        .mockResolvedValueOnce(false) // customizeAgents
        .mockResolvedValueOnce(true) // register agent
        .mockResolvedValueOnce(false) // decline codegraph install
        .mockResolvedValueOnce(false); // decline RTK install
      vi.mocked((prompts as any).__text).mockImplementation(({ message }: { message: string }) => {
        if (message === HEAVY_PROMPT) return "heavy-model";
        if (message === STANDARD_PROMPT) return "standard-model";
        if (message === LIGHT_PROMPT) return "light-model";
        return "";
      });

      await withTempHomeDir(async (homeDir) => {
        const configFile = resolve(homeDir, ".config", "opencode", "opencode.json");
        // Models present, but no ARCS agent entry — one detection leg fails.
        writeFileSync(
          configFile,
          JSON.stringify(
            { model: "provider/existing-model", small_model: "provider/existing-small" },
            null,
            2,
          ),
        );

        await runSetup("init");

        expect((prompts as any).__confirm).not.toHaveBeenCalledWith(
          expect.objectContaining({ message: expect.stringContaining(REUSE_MESSAGE) }),
        );
        for (const message of [HEAVY_PROMPT, STANDARD_PROMPT, LIGHT_PROMPT]) {
          expect((prompts as any).__text).toHaveBeenCalledWith(
            expect.objectContaining({ message }),
          );
        }

        const updated = JSON.parse(readFileSync(configFile, "utf-8")) as Record<string, unknown>;
        expect(updated.model).toBe("standard-model");
        expect(updated.small_model).toBe("light-model");
      });
    });
  });

  describe("reuse existing Claude Code config confirm", () => {
    const REUSE_MESSAGE = "Reuse the existing Claude Code model config?";
    const HEAVY_PROMPT = "Heavy model (reasoning, synthesis)";
    const STANDARD_PROMPT = "Standard model (orchestration)";
    const LIGHT_PROMPT = "Light/fast model (read-only, exploration)";
    const PRIMARY_PROMPT = "Which ARCS primary should be the default in Claude Code?";
    const DEFAULT_PRIMARY = "arcs-orchestrate";

    const REUSED = { heavy: "opus", standard: "sonnet", light: "inherit" };

    /** Manifest shape written by scripts/deploy-claudecode-bundle.mjs on every deploy. */
    function writeBundleManifest(homeDir: string, manifest: unknown) {
      mkdirSync(resolve(homeDir, ".claude"), { recursive: true });
      writeFileSync(
        resolve(homeDir, ".claude", ".arcs-bundle.json"),
        JSON.stringify(manifest, null, 2),
      );
    }

    function manifestWith(tierModels?: Record<string, string>) {
      return {
        bundleId: "arcs-claudecode-bundle",
        agents: [
          {
            id: "arcs-orchestrate",
            promptDestination: "agents/arcs-orchestrate.md",
            sourceHash: "abc",
          },
        ],
        ...(tierModels ? { tierModels } : {}),
      };
    }

    /** Selects Claude Code only, stubs the deploy spawn, and resets the select mock. */
    async function setupClaudeOnly() {
      const prompts = await import("@clack/prompts");
      const actualChildProcess =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");

      vi.mocked((prompts as any).__multiselect).mockResolvedValue(["claudecode"]);
      vi.mocked((prompts as any).__select).mockReset();
      vi.mocked((prompts as any).__select).mockResolvedValue(DEFAULT_PRIMARY);

      vi.mocked(childProcess.spawnSync).mockImplementation(((cmd: any, args: any, options: any) => {
        if (cmd === "node") {
          return {
            status: 0,
            stdout: JSON.stringify({
              source: "mock-source",
              destination: "mock-destination",
              filesAdded: [],
              filesChanged: [],
              filesRemoved: [],
            }),
            stderr: "",
          } as any;
        }
        if (
          cmd === "rtk" ||
          cmd === "codegraph" ||
          cmd === "sh" ||
          cmd === "npm" ||
          cmd === "brew"
        ) {
          return { status: 1, stdout: "", stderr: "" } as any;
        }
        return (actualChildProcess.spawnSync as any)(cmd, args, options);
      }) as any);
    }

    function expectDeployedWith(
      models: { heavy: string; standard: string; light: string },
      primaryAgent: string = DEFAULT_PRIMARY,
    ) {
      expect(childProcess.spawnSync).toHaveBeenCalledWith(
        "node",
        expect.arrayContaining([expect.stringContaining("deploy-claudecode-bundle.mjs")]),
        expect.objectContaining({
          env: expect.objectContaining({
            DEPLOY_MODEL_HEAVY: models.heavy,
            DEPLOY_MODEL_STANDARD: models.standard,
            DEPLOY_MODEL_LIGHT: models.light,
            DEPLOY_PRIMARY_AGENT: primaryAgent,
          }),
        }),
      );
    }

    it("offers reuse and skips every tier prompt when the user accepts", async () => {
      const prompts = await import("@clack/prompts");
      await setupClaudeOnly();

      vi.mocked((prompts as any).__confirm)
        .mockResolvedValueOnce(true) // deploy to Claude Code
        .mockResolvedValueOnce(true) // reuse existing config
        .mockResolvedValueOnce(false) // decline codegraph install
        .mockResolvedValueOnce(false); // decline RTK install

      await withTempHomeDir(async (homeDir) => {
        writeBundleManifest(homeDir, manifestWith(REUSED));

        await runSetup("config");

        // The confirm surfaces the recovered values it will reuse
        expect((prompts as any).__confirm).toHaveBeenCalledWith(
          expect.objectContaining({
            message: expect.stringContaining(REUSE_MESSAGE),
            initialValue: true,
          }),
        );
        for (const value of [REUSED.heavy, REUSED.standard, REUSED.light]) {
          expect((prompts as any).__confirm).toHaveBeenCalledWith(
            expect.objectContaining({ message: expect.stringContaining(value) }),
          );
        }

        // No tier prompts at all — only the primary orchestrator pick
        for (const message of [HEAVY_PROMPT, STANDARD_PROMPT, LIGHT_PROMPT]) {
          expect((prompts as any).__select).not.toHaveBeenCalledWith(
            expect.objectContaining({ message }),
          );
        }
        expect((prompts as any).__select).toHaveBeenCalledTimes(1);
        expect((prompts as any).__select).toHaveBeenCalledWith(
          expect.objectContaining({ message: PRIMARY_PROMPT }),
        );

        // Deploy still runs, with the recovered values verbatim
        expectDeployedWith(REUSED);
      });
    });

    it("falls through to the tier prompt sequence when the user declines reuse", async () => {
      const prompts = await import("@clack/prompts");
      await setupClaudeOnly();

      vi.mocked((prompts as any).__confirm)
        .mockResolvedValueOnce(true) // deploy to Claude Code
        .mockResolvedValueOnce(false) // decline reuse
        .mockResolvedValueOnce(false) // decline codegraph install
        .mockResolvedValueOnce(false); // decline RTK install
      vi.mocked((prompts as any).__select).mockImplementation(
        ({ message }: { message: string }) => {
          if (message === HEAVY_PROMPT) return "picked-heavy";
          if (message === STANDARD_PROMPT) return "picked-standard";
          if (message === LIGHT_PROMPT) return "picked-light";
          if (message === PRIMARY_PROMPT) return DEFAULT_PRIMARY;
          return "";
        },
      );

      await withTempHomeDir(async (homeDir) => {
        writeBundleManifest(homeDir, manifestWith(REUSED));

        await runSetup("config");

        expect((prompts as any).__confirm).toHaveBeenCalledWith(
          expect.objectContaining({ message: expect.stringContaining(REUSE_MESSAGE) }),
        );
        for (const message of [HEAVY_PROMPT, STANDARD_PROMPT, LIGHT_PROMPT]) {
          expect((prompts as any).__select).toHaveBeenCalledWith(
            expect.objectContaining({ message }),
          );
        }

        expectDeployedWith({
          heavy: "picked-heavy",
          standard: "picked-standard",
          light: "picked-light",
        });
      });
    });

    it("never offers reuse when the manifest records an incomplete tier set", async () => {
      const prompts = await import("@clack/prompts");
      await setupClaudeOnly();

      vi.mocked((prompts as any).__confirm)
        .mockResolvedValueOnce(true) // deploy to Claude Code
        .mockResolvedValueOnce(false) // decline codegraph install
        .mockResolvedValueOnce(false); // decline RTK install
      vi.mocked((prompts as any).__select).mockImplementation(
        ({ message }: { message: string }) => {
          if (message === HEAVY_PROMPT) return "picked-heavy";
          if (message === STANDARD_PROMPT) return "picked-standard";
          if (message === LIGHT_PROMPT) return "picked-light";
          if (message === PRIMARY_PROMPT) return DEFAULT_PRIMARY;
          return "";
        },
      );

      await withTempHomeDir(async (homeDir) => {
        // "ok" manifest, but light is missing — tier read-back is all-or-nothing.
        writeBundleManifest(
          homeDir,
          manifestWith({ heavy: REUSED.heavy, standard: REUSED.standard }),
        );

        await runSetup("init");

        expect((prompts as any).__confirm).not.toHaveBeenCalledWith(
          expect.objectContaining({ message: expect.stringContaining(REUSE_MESSAGE) }),
        );
        for (const message of [HEAVY_PROMPT, STANDARD_PROMPT, LIGHT_PROMPT]) {
          expect((prompts as any).__select).toHaveBeenCalledWith(
            expect.objectContaining({ message }),
          );
        }

        expectDeployedWith({
          heavy: "picked-heavy",
          standard: "picked-standard",
          light: "picked-light",
        });
      });
    });

    it("never offers reuse when no bundle manifest exists", async () => {
      const prompts = await import("@clack/prompts");
      await setupClaudeOnly();

      vi.mocked((prompts as any).__confirm)
        .mockResolvedValueOnce(true) // deploy to Claude Code
        .mockResolvedValueOnce(false) // decline codegraph install
        .mockResolvedValueOnce(false); // decline RTK install
      vi.mocked((prompts as any).__select).mockImplementation(
        ({ message }: { message: string }) => {
          if (message === HEAVY_PROMPT) return "picked-heavy";
          if (message === STANDARD_PROMPT) return "picked-standard";
          if (message === LIGHT_PROMPT) return "picked-light";
          if (message === PRIMARY_PROMPT) return DEFAULT_PRIMARY;
          return "";
        },
      );

      await withTempHomeDir(async () => {
        // No ~/.claude/.arcs-bundle.json seeded at all.
        await runSetup("init");

        expect((prompts as any).__confirm).not.toHaveBeenCalledWith(
          expect.objectContaining({ message: expect.stringContaining(REUSE_MESSAGE) }),
        );
        for (const message of [HEAVY_PROMPT, STANDARD_PROMPT, LIGHT_PROMPT]) {
          expect((prompts as any).__select).toHaveBeenCalledWith(
            expect.objectContaining({ message }),
          );
        }

        expectDeployedWith({
          heavy: "picked-heavy",
          standard: "picked-standard",
          light: "picked-light",
        });
      });
    });

    it("passes the picked primary orchestrator to the deploy script", async () => {
      const prompts = await import("@clack/prompts");
      await setupClaudeOnly();

      vi.mocked((prompts as any).__confirm)
        .mockResolvedValueOnce(true) // deploy to Claude Code
        .mockResolvedValueOnce(false) // decline codegraph install
        .mockResolvedValueOnce(false); // decline RTK install
      vi.mocked((prompts as any).__select).mockImplementation(
        ({ message }: { message: string }) => {
          if (message === HEAVY_PROMPT) return "picked-heavy";
          if (message === STANDARD_PROMPT) return "picked-standard";
          if (message === LIGHT_PROMPT) return "picked-light";
          if (message === PRIMARY_PROMPT) return "arcs-orchestrate-caveman";
          return "";
        },
      );

      await withTempHomeDir(async () => {
        // No ~/.claude/.arcs-bundle.json — the full tier sequence runs.
        await runSetup("init");

        expect((prompts as any).__select).toHaveBeenCalledWith(
          expect.objectContaining({ message: PRIMARY_PROMPT, initialValue: DEFAULT_PRIMARY }),
        );
        expectDeployedWith(
          { heavy: "picked-heavy", standard: "picked-standard", light: "picked-light" },
          "arcs-orchestrate-caveman",
        );
      });
    });

    /** settings.json shape written by the deploy script's settings merge. */
    function writeClaudeSettings(homeDir: string, settings: unknown) {
      mkdirSync(resolve(homeDir, ".claude"), { recursive: true });
      writeFileSync(
        resolve(homeDir, ".claude", "settings.json"),
        JSON.stringify(settings, null, 2),
      );
    }

    /** Mirrors pressing Enter on the primary prompt: resolves to its pre-selection. */
    async function acceptPreSelectedPrimary() {
      const prompts = await import("@clack/prompts");
      vi.mocked((prompts as any).__select).mockImplementation(
        ({ message, initialValue }: { message: string; initialValue?: string }) => {
          if (message === HEAVY_PROMPT) return "picked-heavy";
          if (message === STANDARD_PROMPT) return "picked-standard";
          if (message === LIGHT_PROMPT) return "picked-light";
          if (message === PRIMARY_PROMPT) return initialValue;
          return "";
        },
      );
    }

    it("pre-selects the primary the last deploy installed so a redeploy preserves it", async () => {
      const prompts = await import("@clack/prompts");
      await setupClaudeOnly();
      await acceptPreSelectedPrimary();

      vi.mocked((prompts as any).__confirm)
        .mockResolvedValueOnce(true) // deploy to Claude Code
        .mockResolvedValueOnce(false) // decline codegraph install
        .mockResolvedValueOnce(false); // decline RTK install

      await withTempHomeDir(async (homeDir) => {
        writeClaudeSettings(homeDir, { agent: "arcs-flash" });

        await runSetup("config");

        expect((prompts as any).__select).toHaveBeenCalledWith(
          expect.objectContaining({ message: PRIMARY_PROMPT, initialValue: "arcs-flash" }),
        );
        expectDeployedWith(
          { heavy: "picked-heavy", standard: "picked-standard", light: "picked-light" },
          "arcs-flash",
        );
      });
    });

    it("falls back to arcs-orchestrate when settings.json records no usable primary", async () => {
      const prompts = await import("@clack/prompts");
      await setupClaudeOnly();
      await acceptPreSelectedPrimary();

      vi.mocked((prompts as any).__confirm)
        .mockResolvedValueOnce(true) // deploy to Claude Code
        .mockResolvedValueOnce(false) // decline codegraph install
        .mockResolvedValueOnce(false); // decline RTK install

      await withTempHomeDir(async (homeDir) => {
        // A real settings.json, but `agent` names a sub-agent, not an ARCS primary.
        writeClaudeSettings(homeDir, { agent: "graph-explorer" });

        await runSetup("config");

        expect((prompts as any).__select).toHaveBeenCalledWith(
          expect.objectContaining({ message: PRIMARY_PROMPT, initialValue: DEFAULT_PRIMARY }),
        );
      });
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
