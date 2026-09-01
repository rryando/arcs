import * as childProcess from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runSetup } from "../src/cli/setup.js";
import { getDataDir } from "../src/utils/paths.js";
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

const DEPLOY_RESULT = JSON.stringify({
  dryRun: false,
  platform: "pi",
  scope: "global",
  source: "/bundle",
  destination: "/tmp/pi-home",
  modelConfig: { heavy: "inherit", standard: "inherit", light: "inherit" },
  thinkingConfig: { heavy: "high", standard: "medium", light: "low" },
  filesAdded: ["agent/agents/software-engineer.md"],
  filesChanged: [],
  filesRemoved: [],
  filesUnchanged: [],
});

function configPath(): string {
  return resolve(getDataDir(), "config.json");
}

function seedPiBundle(homeDir: string, tierModels: Record<string, string>): void {
  const manifestPath = resolve(homeDir, ".pi", ".arcs-bundle.json");
  mkdirSync(resolve(homeDir, ".pi"), { recursive: true });
  writeFileSync(
    manifestPath,
    JSON.stringify({
      bundleId: "arcs-pi-bundle",
      installMode: "pi-global",
      tierModels,
      agents: [{ id: "software-engineer", promptDestination: "agent/agents/software-engineer.md" }],
    }),
  );
}

describe("pi setup flow", () => {
  beforeEach(async () => {
    const prompts = await import("@clack/prompts");

    vi.mocked((prompts as any).__confirm).mockReset();
    vi.mocked((prompts as any).__note).mockReset();
    vi.mocked((prompts as any).__text).mockReset();
    vi.mocked((prompts as any).__multiselect).mockReset();
    vi.mocked((prompts as any).__select).mockReset();
    vi.mocked((prompts as any).__text).mockResolvedValue("");
    vi.mocked((prompts as any).__select).mockResolvedValue("inherit");
    vi.mocked((prompts as any).__multiselect).mockResolvedValue(["pi"]);

    const actualChildProcess =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    vi.mocked(childProcess.spawnSync).mockReset();
    // Fail-closed default: external binaries and installers must never execute
    // for real from these tests. The pi deploy script invocation is stubbed to
    // a success envelope so no filesystem or network work happens.
    vi.mocked(childProcess.spawnSync).mockImplementation(((cmd: any, args: any, options: any) => {
      if (cmd === "rtk" || cmd === "codegraph" || cmd === "sh" || cmd === "npm" || cmd === "brew") {
        return { status: 1, stdout: "", stderr: "" } as any;
      }
      if (
        cmd === "node" &&
        Array.isArray(args) &&
        args.some((a) => a.endsWith("deploy-pi-bundle.mjs"))
      ) {
        return { status: 0, stdout: DEPLOY_RESULT, stderr: "" } as any;
      }
      return (actualChildProcess.spawnSync as any)(cmd, args, options);
    }) as any);
    vi.mocked(childProcess.execSync).mockReset();
    // Simulate ONLY pi being installed so the wizard takes the single-platform
    // confirm path (opencode/claude detection throws).
    vi.mocked(childProcess.execSync).mockImplementation(((cmd: any, ...rest: any[]) => {
      if (typeof cmd === "string" && cmd.includes("which pi")) {
        return "/usr/local/bin/pi\n" as any;
      }
      if (
        typeof cmd === "string" &&
        (cmd.includes("which opencode") ||
          cmd.includes("which claude") ||
          cmd.includes("rtk") ||
          cmd.includes("codegraph"))
      ) {
        throw new Error("binary not installed in tests");
      }
      return (actualChildProcess.execSync as any)(cmd, ...rest);
    }) as any);
  });

  it("deploys ARCS sub-agents to pi with inherit tier models and records the ide", async () => {
    await withTempHomeDir(async (homeDir) => {
      const prompts = await import("@clack/prompts");
      vi.mocked((prompts as any).__confirm).mockResolvedValue(true);

      await runSetup("init");

      // Deploy invoked with DEPLOY_MODEL_* all inherit
      const deployCalls = vi
        .mocked(childProcess.spawnSync)
        .mock.calls.filter(
          (call) =>
            call[0] === "node" &&
            Array.isArray(call[1]) &&
            (call[1] as string[]).some((a) => a.endsWith("deploy-pi-bundle.mjs")),
        );
      expect(deployCalls).toHaveLength(1);
      const deployEnv = (deployCalls[0][2] as { env?: Record<string, string> }).env ?? {};
      expect(deployEnv.DEPLOY_DRY_RUN).toBe("false");
      expect(deployEnv.DEPLOY_MODEL_HEAVY).toBe("inherit");
      expect(deployEnv.DEPLOY_MODEL_STANDARD).toBe("inherit");
      expect(deployEnv.DEPLOY_MODEL_LIGHT).toBe("inherit");
      expect(deployEnv.DEPLOY_THINKING_HEAVY).toBe("high");
      expect(deployEnv.DEPLOY_THINKING_STANDARD).toBe("medium");
      expect(deployEnv.DEPLOY_THINKING_LIGHT).toBe("low");

      // Config records the pi platform
      const config = JSON.parse(readFileSync(configPath(), "utf-8")) as { ides: string[] };
      expect(config.ides).toContain("pi");

      // codegraph/rtk never invoked for a pi-only selection
      const externalCalls = vi
        .mocked(childProcess.spawnSync)
        .mock.calls.filter((call) => call[0] === "rtk" || call[0] === "codegraph");
      expect(externalCalls).toHaveLength(0);

      void homeDir;
    });
  });

  it("reuses the previous pi model config when the user keeps it", async () => {
    await withTempHomeDir(async (homeDir) => {
      const prompts = await import("@clack/prompts");
      seedPiBundle(homeDir, {
        heavy: "opencode/deepseek-v4",
        standard: "opencode/deepseek-v4-lite",
        light: "opencode/deepseek-v4-mini",
      });
      vi.mocked((prompts as any).__confirm).mockResolvedValue(true);

      await runSetup("init");

      const deployCalls = vi
        .mocked(childProcess.spawnSync)
        .mock.calls.filter(
          (call) =>
            call[0] === "node" &&
            Array.isArray(call[1]) &&
            (call[1] as string[]).some((a) => a.endsWith("deploy-pi-bundle.mjs")),
        );
      expect(deployCalls).toHaveLength(1);
      const deployEnv = (deployCalls[0][2] as { env?: Record<string, string> }).env ?? {};
      expect(deployEnv.DEPLOY_MODEL_HEAVY).toBe("opencode/deepseek-v4");
      expect(deployEnv.DEPLOY_MODEL_STANDARD).toBe("opencode/deepseek-v4-lite");
      expect(deployEnv.DEPLOY_MODEL_LIGHT).toBe("opencode/deepseek-v4-mini");
      // reuse path skips the tier selects entirely
      expect(vi.mocked((prompts as any).__select)).not.toHaveBeenCalled();
    });
  });

  it("offers discovered pi provider/model IDs as tier choices", async () => {
    await withTempHomeDir(async () => {
      const prompts = await import("@clack/prompts");
      const actualChildProcess =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      vi.mocked((prompts as any).__confirm).mockResolvedValue(true);
      vi.mocked(childProcess.execSync).mockImplementation(((cmd: any, ...rest: any[]) => {
        if (cmd === "pi --list-models") {
          return `provider model context max-out thinking images
openai-codex  gpt-5.4  1  1  yes  yes
opencode  claude-sonnet-4-6  1  1  no  yes
` as any;
        }
        return (actualChildProcess.execSync as any)(cmd, ...rest);
      }) as any);
      vi.mocked((prompts as any).__select).mockImplementation(async (input: any) => {
        const values = input.options.map((option: any) => option.value);
        return values.includes("openai-codex/gpt-5.4") ? "openai-codex/gpt-5.4" : "inherit";
      });

      await runSetup("init");

      const deployCall = vi
        .mocked(childProcess.spawnSync)
        .mock.calls.find(
          (call) =>
            call[0] === "node" &&
            Array.isArray(call[1]) &&
            (call[1] as string[]).some((arg) => arg.endsWith("deploy-pi-bundle.mjs")),
        );
      const deployEnv = (deployCall?.[2] as { env?: Record<string, string> }).env ?? {};
      expect(deployEnv.DEPLOY_MODEL_HEAVY).toBe("openai-codex/gpt-5.4");
      expect(deployEnv.DEPLOY_MODEL_STANDARD).toBe("openai-codex/gpt-5.4");
      expect(deployEnv.DEPLOY_MODEL_LIGHT).toBe("openai-codex/gpt-5.4");
    });
  });

  it("accepts a custom model id through the pi tier select", async () => {
    await withTempHomeDir(async () => {
      const prompts = await import("@clack/prompts");
      vi.mocked((prompts as any).__confirm).mockResolvedValue(true);
      vi.mocked((prompts as any).__select).mockResolvedValue("__custom__");
      vi.mocked((prompts as any).__text)
        .mockResolvedValueOnce("opencode/deepseek-r1")
        .mockResolvedValueOnce("opencode/deepseek-v4")
        .mockResolvedValueOnce("opencode/deepseek-v4-mini");

      await runSetup("init");

      const deployCalls = vi
        .mocked(childProcess.spawnSync)
        .mock.calls.filter(
          (call) =>
            call[0] === "node" &&
            Array.isArray(call[1]) &&
            (call[1] as string[]).some((a) => a.endsWith("deploy-pi-bundle.mjs")),
        );
      expect(deployCalls).toHaveLength(1);
      const deployEnv = (deployCalls[0][2] as { env?: Record<string, string> }).env ?? {};
      expect(deployEnv.DEPLOY_MODEL_HEAVY).toBe("opencode/deepseek-r1");
      expect(deployEnv.DEPLOY_MODEL_STANDARD).toBe("opencode/deepseek-v4");
      expect(deployEnv.DEPLOY_MODEL_LIGHT).toBe("opencode/deepseek-v4-mini");
    });
  });

  it("skips deployment and records no ide when the user declines", async () => {
    await withTempHomeDir(async () => {
      const prompts = await import("@clack/prompts");
      vi.mocked((prompts as any).__confirm).mockResolvedValue(false);

      await runSetup("init");

      const deployCalls = vi
        .mocked(childProcess.spawnSync)
        .mock.calls.filter(
          (call) =>
            call[0] === "node" &&
            Array.isArray(call[1]) &&
            (call[1] as string[]).some((a) => a.endsWith("deploy-pi-bundle.mjs")),
        );
      expect(deployCalls).toHaveLength(0);
      const config = JSON.parse(readFileSync(configPath(), "utf-8")) as { ides: string[] };
      expect(config.ides).not.toContain("pi");
    });
  });
});
