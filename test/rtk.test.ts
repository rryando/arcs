import * as childProcess from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  appendFileSync: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  log: { info: vi.fn(), warn: vi.fn() },
  isCancel: vi.fn(() => false),
  note: vi.fn(),
}));

// Mock setup.ts dependencies that aren't relevant to rtk tests
vi.mock("../src/cli/config.js", () => ({
  configExists: vi.fn(() => false),
  extractModelPreFills: vi.fn(() => ({})),
  readConfig: vi.fn(),
  readOpenCodeConfig: vi.fn(),
  writeConfig: vi.fn(),
}));

vi.mock("../src/cli/instructions.js", () => ({
  applyAgentModelConfig: vi.fn(),
  displayPath: vi.fn(),
  opencodeHasAgent: vi.fn(),
  writeOpencodeAgent: vi.fn(),
}));

vi.mock("../src/cli/bundle-installer.js", () => ({
  detectArcsBundleInstall: vi.fn(),
  installArcsBundle: vi.fn(),
}));

const mockedExecSync = vi.mocked(childProcess.execSync);
const mockedSpawnSync = vi.mocked(childProcess.spawnSync);

import { detectRtk } from "../src/utils/rtk.js";

beforeEach(() => {
  vi.clearAllMocks();
});

// Helper: a spawnSync result object with sensible defaults.
function spawnResult(
  overrides: Partial<{
    status: number | null;
    stdout: string;
    stderr: string;
    error: NodeJS.ErrnoException | undefined;
  }>,
) {
  return {
    status: overrides.status ?? 0,
    stdout: overrides.stdout ?? "",
    stderr: overrides.stderr ?? "",
    error: overrides.error as unknown as Error,
    pid: 1234,
    output: [],
    signal: null,
  };
}

// Helper: execSync implementation simulating an installed rtk binary.
function mockRtkInstalled() {
  mockedExecSync.mockImplementation((cmd) => {
    if (cmd === "rtk --version") return "rtk 0.9.9\n";
    if (cmd === "which rtk") return "/usr/local/bin/rtk\n";
    return "";
  });
}

describe("detectRtk", () => {
  it("returns available:false when binary is not found (ENOENT)", () => {
    const err = new Error("Command failed") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    mockedExecSync.mockImplementation(() => {
      throw err;
    });

    const result = detectRtk();
    expect(result).toEqual({ available: false });
  });

  it("parses version correctly from stdout", () => {
    mockRtkInstalled();

    const result = detectRtk();
    expect(result).toEqual({
      available: true,
      version: "0.9.9",
      path: "/usr/local/bin/rtk",
    });
  });

  it("handles timeout gracefully", () => {
    const err = new Error("Command timed out") as NodeJS.ErrnoException;
    err.code = "ETIMEDOUT";
    mockedExecSync.mockImplementation(() => {
      throw err;
    });

    const result = detectRtk();
    expect(result).toEqual({ available: false });
  });
});

describe("promptRtkInstall", () => {
  it("wires both hosts without an install prompt when rtk is available and both are selected", async () => {
    const { promptRtkInstall } = await import("../src/cli/setup.js");
    const prompts = await import("@clack/prompts");

    mockRtkInstalled();
    mockedSpawnSync.mockReturnValue(spawnResult({ status: 0, stdout: "ok" }));

    await expect(promptRtkInstall(true, true)).resolves.toBeUndefined();

    // Both hosts selected → wiring needs no consent prompt.
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      "rtk",
      ["init", "-g", "--opencode", "--auto-patch"],
      expect.any(Object),
    );
  });

  it("omits --opencode when only Claude Code is selected", async () => {
    const { promptRtkInstall } = await import("../src/cli/setup.js");
    const prompts = await import("@clack/prompts");

    mockRtkInstalled();
    mockedSpawnSync.mockReturnValue(spawnResult({ status: 0, stdout: "ok" }));

    await expect(promptRtkInstall(false, true)).resolves.toBeUndefined();

    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      "rtk",
      ["init", "-g", "--auto-patch"],
      expect.any(Object),
    );
  });

  it("asks before wiring when only OpenCode is selected, and skips wiring on decline", async () => {
    const { promptRtkInstall } = await import("../src/cli/setup.js");
    const prompts = await import("@clack/prompts");

    mockRtkInstalled();
    // `rtk init -g` also configures Claude Code — the user declines that.
    vi.mocked(prompts.confirm).mockResolvedValue(false);
    vi.mocked(prompts.isCancel).mockReturnValue(false);

    await expect(promptRtkInstall(true, false)).resolves.toBeUndefined();

    expect(prompts.confirm).toHaveBeenCalled();
    expect(mockedSpawnSync).not.toHaveBeenCalled();
  });

  it("does not throw when rtk is absent and all installers fail", async () => {
    const { promptRtkInstall } = await import("../src/cli/setup.js");
    const prompts = await import("@clack/prompts");

    // rtk not available.
    mockedExecSync.mockImplementation(() => {
      throw new Error("not found");
    });
    // User confirms install...
    vi.mocked(prompts.confirm).mockResolvedValue(true);
    vi.mocked(prompts.isCancel).mockReturnValue(false);
    // ...but every installer (platform script + brew fallback) fails.
    mockedSpawnSync.mockReturnValue(spawnResult({ status: 1, stderr: "install failed" }));

    await expect(promptRtkInstall(true, true)).resolves.toBeUndefined();
  });

  it("does not throw when the user declines installation", async () => {
    const { promptRtkInstall } = await import("../src/cli/setup.js");
    const prompts = await import("@clack/prompts");

    mockedExecSync.mockImplementation(() => {
      throw new Error("not found");
    });
    vi.mocked(prompts.confirm).mockResolvedValue(false);
    vi.mocked(prompts.isCancel).mockReturnValue(false);

    await expect(promptRtkInstall(true, true)).resolves.toBeUndefined();
    // Declined → no installer should have been spawned.
    expect(mockedSpawnSync).not.toHaveBeenCalled();
  });
});
