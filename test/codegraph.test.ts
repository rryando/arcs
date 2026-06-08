import * as childProcess from "node:child_process";
import * as fs from "node:fs";
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

// Mock setup.ts dependencies that aren't relevant to codegraph tests
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
const mockedExistsSync = vi.mocked(fs.existsSync);
const mockedReadFileSync = vi.mocked(fs.readFileSync);
const mockedAppendFileSync = vi.mocked(fs.appendFileSync);

import { detectCodegraph, runIndex } from "../src/utils/codegraph.js";

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

describe("detectCodegraph", () => {
  it("returns available:false when binary is not found (ENOENT)", () => {
    const err = new Error("Command failed") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    mockedExecSync.mockImplementation(() => {
      throw err;
    });

    const result = detectCodegraph();
    expect(result).toEqual({ available: false });
  });

  it("parses version correctly from stdout", () => {
    mockedExecSync.mockImplementation((cmd) => {
      if (cmd === "codegraph --version") return "codegraph 0.9.9\n";
      if (cmd === "which codegraph") return "/usr/local/bin/codegraph\n";
      return "";
    });

    const result = detectCodegraph();
    expect(result).toEqual({
      available: true,
      version: "0.9.9",
      path: "/usr/local/bin/codegraph",
    });
  });

  it("handles timeout gracefully", () => {
    const err = new Error("Command timed out") as NodeJS.ErrnoException;
    err.code = "ETIMEDOUT";
    mockedExecSync.mockImplementation(() => {
      throw err;
    });

    const result = detectCodegraph();
    expect(result).toEqual({ available: false });
  });
});

describe("runIndex", () => {
  it("returns error when codegraph not available", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const result = runIndex("/tmp/project");
    expect(result).toEqual({
      success: false,
      error: "codegraph binary not found",
      code: "ENOENT",
    });
  });

  it("returns success with status when index + status succeed", () => {
    mockedExecSync.mockImplementation((cmd) => {
      if (cmd === "codegraph --version") return "codegraph 0.9.9\n";
      if (cmd === "which codegraph") return "/usr/local/bin/codegraph\n";
      return "";
    });
    // First spawnSync = `index ... --force --quiet` (no JSON, exit 0).
    // Second spawnSync = `status --json` (parsed by cgStatus).
    const status = {
      initialized: true,
      nodeCount: 79,
      edgeCount: 120,
      fileCount: 30,
      nodesByKind: { function: 50, class: 10 },
    };
    mockedSpawnSync
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: "Indexed" }))
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: JSON.stringify(status) }));
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(".codegraph/\n");

    const result = runIndex("/tmp/project");
    expect(result).toEqual({ success: true, status });
  });

  it("returns error with timeout code when the index process times out", () => {
    mockedExecSync.mockImplementation((cmd) => {
      if (cmd === "codegraph --version") return "codegraph 0.9.9\n";
      if (cmd === "which codegraph") return "/usr/local/bin/codegraph\n";
      return "";
    });
    const timeoutErr = new Error("spawnSync codegraph ETIMEDOUT") as NodeJS.ErrnoException;
    timeoutErr.code = "ETIMEDOUT";
    mockedSpawnSync.mockReturnValue(spawnResult({ status: null, error: timeoutErr }));

    const result = runIndex("/tmp/project");
    expect(result).toEqual({
      success: false,
      error: "spawnSync codegraph ETIMEDOUT",
      code: "ETIMEDOUT",
    });
  });

  it("returns error when index exits non-zero", () => {
    mockedExecSync.mockImplementation((cmd) => {
      if (cmd === "codegraph --version") return "codegraph 0.9.9\n";
      if (cmd === "which codegraph") return "/usr/local/bin/codegraph\n";
      return "";
    });
    mockedSpawnSync.mockReturnValue(spawnResult({ status: 2, stderr: "boom" }));

    const result = runIndex("/tmp/project");
    expect(result).toEqual({
      success: false,
      error: "boom",
      code: "EXIT_2",
    });
  });

  it("returns ENODATA error when status returns no valid JSON", () => {
    mockedExecSync.mockImplementation((cmd) => {
      if (cmd === "codegraph --version") return "codegraph 0.9.9\n";
      if (cmd === "which codegraph") return "/usr/local/bin/codegraph\n";
      return "";
    });
    mockedSpawnSync
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: "Indexed" }))
      // status --json prints a non-JSON notice (with ANSI) → no-data.
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: "\u001b[36mℹ\u001b[0m no data" }));
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(".codegraph/\n");

    const result = runIndex("/tmp/project");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("ENODATA");
  });

  it("adds .codegraph/ to .gitignore on successful index", () => {
    mockedExecSync.mockImplementation((cmd) => {
      if (cmd === "codegraph --version") return "codegraph 0.9.9\n";
      if (cmd === "which codegraph") return "/usr/local/bin/codegraph\n";
      return "";
    });
    const status = {
      initialized: true,
      nodeCount: 10,
      edgeCount: 5,
      fileCount: 3,
      nodesByKind: {},
    };
    mockedSpawnSync
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: "Indexed" }))
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: JSON.stringify(status) }));
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("node_modules/\ndist/\n");

    runIndex("/tmp/project");

    expect(mockedAppendFileSync).toHaveBeenCalledWith(
      "/tmp/project/.gitignore",
      ".codegraph/\n",
      "utf-8",
    );
  });

  it("does not duplicate .codegraph/ in .gitignore if already present", () => {
    mockedExecSync.mockImplementation((cmd) => {
      if (cmd === "codegraph --version") return "codegraph 0.9.9\n";
      if (cmd === "which codegraph") return "/usr/local/bin/codegraph\n";
      return "";
    });
    const status = {
      initialized: true,
      nodeCount: 10,
      edgeCount: 5,
      fileCount: 3,
      nodesByKind: {},
    };
    mockedSpawnSync
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: "Indexed" }))
      .mockReturnValueOnce(spawnResult({ status: 0, stdout: JSON.stringify(status) }));
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("node_modules/\n.codegraph/\ndist/\n");

    runIndex("/tmp/project");

    expect(mockedAppendFileSync).not.toHaveBeenCalled();
  });
});

describe("promptCodegraphInstall", () => {
  it("skips install and wiring chatter when codegraph is already available", async () => {
    const { promptCodegraphInstall } = await import("../src/cli/setup.js");
    const prompts = await import("@clack/prompts");

    mockedExecSync.mockImplementation((cmd) => {
      if (cmd === "codegraph --version") return "codegraph 0.9.9\n";
      if (cmd === "which codegraph") return "/usr/local/bin/codegraph\n";
      return "";
    });
    // wireCodegraph() shells out to `codegraph install ...` and `codegraph index ...`.
    // Treat those as succeeding; the key assertion is that no install confirm prompt ran.
    mockedSpawnSync.mockReturnValue(spawnResult({ status: 0, stdout: "ok" }));

    await expect(promptCodegraphInstall()).resolves.toBeUndefined();

    // Already available → must NOT prompt the user to install.
    expect(prompts.confirm).not.toHaveBeenCalled();
  });

  it("does not throw when codegraph is absent and all installers fail", async () => {
    const { promptCodegraphInstall } = await import("../src/cli/setup.js");
    const prompts = await import("@clack/prompts");

    // codegraph not available.
    mockedExecSync.mockImplementation(() => {
      throw new Error("not found");
    });
    // User confirms install...
    vi.mocked(prompts.confirm).mockResolvedValue(true);
    vi.mocked(prompts.isCancel).mockReturnValue(false);
    // ...but every installer (platform + npm fallback) fails.
    mockedSpawnSync.mockReturnValue(spawnResult({ status: 1, stderr: "install failed" }));

    await expect(promptCodegraphInstall()).resolves.toBeUndefined();
  });

  it("does not throw when the user declines installation", async () => {
    const { promptCodegraphInstall } = await import("../src/cli/setup.js");
    const prompts = await import("@clack/prompts");

    mockedExecSync.mockImplementation(() => {
      throw new Error("not found");
    });
    vi.mocked(prompts.confirm).mockResolvedValue(false);
    vi.mocked(prompts.isCancel).mockReturnValue(false);

    await expect(promptCodegraphInstall()).resolves.toBeUndefined();
    // Declined → no installer should have been spawned.
    expect(mockedSpawnSync).not.toHaveBeenCalled();
  });
});
