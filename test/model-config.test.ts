import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  diagnoseOpenCodeConfig,
  extractModelPreFills,
  readOpenCodeConfig,
} from "../src/cli/config.js";
import { applyAgentModelConfig, writeOpencodeAgent } from "../src/cli/instructions.js";

// ---------------------------------------------------------------------------
// A. extractModelPreFills (pure function)
// ---------------------------------------------------------------------------

describe("extractModelPreFills", () => {
  it("returns empty strings for null", () => {
    expect(extractModelPreFills(null)).toEqual({ heavy: "", standard: "", light: "" });
  });

  it("returns empty strings for undefined", () => {
    expect(extractModelPreFills(undefined)).toEqual({ heavy: "", standard: "", light: "" });
  });

  it("returns empty strings for empty object", () => {
    expect(extractModelPreFills({})).toEqual({ heavy: "", standard: "", light: "" });
  });

  it("uses model for all tiers when no small_model", () => {
    expect(extractModelPreFills({ model: "foo/bar" })).toEqual({
      heavy: "foo/bar",
      standard: "foo/bar",
      light: "foo/bar",
    });
  });

  it("uses small_model for light tier when model is also set", () => {
    expect(extractModelPreFills({ model: "foo/bar", small_model: "foo/baz" })).toEqual({
      heavy: "foo/bar",
      standard: "foo/bar",
      light: "foo/baz",
    });
  });

  it("uses small_model for light when no model", () => {
    expect(extractModelPreFills({ small_model: "foo/baz" })).toEqual({
      heavy: "",
      standard: "",
      light: "foo/baz",
    });
  });

  it("treats non-string model as empty string", () => {
    expect(extractModelPreFills({ model: 123 })).toEqual({
      heavy: "",
      standard: "",
      light: "",
    });
  });

  it("treats non-string small_model as empty string", () => {
    expect(extractModelPreFills({ model: "foo/bar", small_model: 42 })).toEqual({
      heavy: "foo/bar",
      standard: "foo/bar",
      light: "foo/bar",
    });
  });

  it("treats non-object input (array) as empty", () => {
    expect(extractModelPreFills([1, 2, 3])).toEqual({ heavy: "", standard: "", light: "" });
  });

  it("treats non-object input (string) as empty", () => {
    expect(extractModelPreFills("hello")).toEqual({ heavy: "", standard: "", light: "" });
  });
});

// ---------------------------------------------------------------------------
// B. readOpenCodeConfig (IO function)
// ---------------------------------------------------------------------------

describe("readOpenCodeConfig", () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "arcs-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempDir, { recursive: true });
  });

  it("returns null when config file does not exist", async () => {
    const result = await readOpenCodeConfig();
    expect(result).toBeNull();
  });

  it("returns parsed JSON when file exists", async () => {
    const configDir = join(tempDir, ".config", "opencode");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "opencode.json"), JSON.stringify({ model: "test/model" }));
    const result = await readOpenCodeConfig();
    expect(result).toEqual({ model: "test/model" });
  });

  it("returns null for malformed JSON", async () => {
    const configDir = join(tempDir, ".config", "opencode");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "opencode.json"), "not json{{{");
    const result = await readOpenCodeConfig();
    expect(result).toBeNull();
  });

  it("returns parsed value for non-object JSON (array)", async () => {
    const configDir = join(tempDir, ".config", "opencode");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "opencode.json"), "[1, 2, 3]");
    const result = await readOpenCodeConfig();
    expect(result).toEqual([1, 2, 3]);
  });

  it("returns parsed value for non-object JSON (number)", async () => {
    const configDir = join(tempDir, ".config", "opencode");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "opencode.json"), "42");
    const result = await readOpenCodeConfig();
    expect(result).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// B2. diagnoseOpenCodeConfig — distinguishes missing vs corrupt vs ok
// ---------------------------------------------------------------------------

describe("diagnoseOpenCodeConfig", () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "arcs-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempDir, { recursive: true });
  });

  it("reports 'missing' when the config file does not exist", async () => {
    const result = await diagnoseOpenCodeConfig();
    expect(result.status).toBe("missing");
  });

  it("reports 'ok' with parsed config when valid", async () => {
    const configDir = join(tempDir, ".config", "opencode");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "opencode.json"), JSON.stringify({ model: "test/model" }));
    const result = await diagnoseOpenCodeConfig();
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.config).toEqual({ model: "test/model" });
    }
  });

  it("reports 'corrupt' with an error when the file exists but is invalid JSON", async () => {
    const configDir = join(tempDir, ".config", "opencode");
    await mkdir(configDir, { recursive: true });
    // Mirrors the real-world corruption: a mangled key splice.
    await writeFile(join(configDir, "opencode.json"), '{ "grap"description": "x" }');
    const result = await diagnoseOpenCodeConfig();
    expect(result.status).toBe("corrupt");
    if (result.status === "corrupt") {
      expect(result.error).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// C. Integration: applyAgentModelConfig (tier resolution via filesystem)
// ---------------------------------------------------------------------------

describe("applyAgentModelConfig", () => {
  let tempDir: string;
  let originalHome: string | undefined;
  let configDir: string;
  let configFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "arcs-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
    configDir = join(tempDir, ".config", "opencode");
    configFile = join(configDir, "opencode.json");
    mkdirSync(configDir, { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempDir, { recursive: true });
  });

  it("does nothing when config file does not exist", () => {
    // Reset HOME to a dir without opencode.json
    const altDir = join(tempDir, "empty");
    mkdirSync(altDir, { recursive: true });
    process.env.HOME = altDir;
    expect(() =>
      applyAgentModelConfig({ heavy: "h/m", standard: "s/m", light: "l/m" }),
    ).not.toThrow();
  });

  it("assigns tier-based models to all agents (including primary)", async () => {
    const config = {
      agent: {
        "ARCS Orchestrator": { prompt: "test" },
        "ARCS Caveman": { prompt: "test" },
        explore: { prompt: "explore things" },
        "software-engineer": { prompt: "code stuff" },
        build: { prompt: "build stuff" },
      },
    };
    writeFileSync(configFile, JSON.stringify(config));

    applyAgentModelConfig({ heavy: "big/model", standard: "mid/model", light: "small/model" });

    const result = JSON.parse(await readFile(configFile, "utf-8"));
    // Sub-agents get tier models
    expect(result.agent.explore.model).toBe("small/model");
    expect(result.agent["software-engineer"].model).toBe("big/model");
    expect(result.agent.build.model).toBe("mid/model");
    // Primary agents are standard tier
    expect(result.agent["ARCS Orchestrator"].model).toBe("mid/model");
    expect(result.agent["ARCS Caveman"].model).toBe("mid/model");
  });

  it("applies perAgent override to sub-agents", async () => {
    const config = {
      agent: {
        explore: { prompt: "explore" },
        "software-engineer": { prompt: "code" },
      },
    };
    writeFileSync(configFile, JSON.stringify(config));

    applyAgentModelConfig({
      heavy: "big/model",
      standard: "mid/model",
      light: "small/model",
      perAgent: { explore: "custom/explorer" },
    });

    const result = JSON.parse(await readFile(configFile, "utf-8"));
    expect(result.agent.explore.model).toBe("custom/explorer");
    expect(result.agent["software-engineer"].model).toBe("big/model");
  });

  it("applies perAgent override to primary agents", async () => {
    const config = {
      agent: {
        "ARCS Orchestrator": { prompt: "test" },
        "ARCS Caveman": { prompt: "test" },
      },
    };
    writeFileSync(configFile, JSON.stringify(config));

    applyAgentModelConfig({
      heavy: "big/model",
      standard: "mid/model",
      light: "small/model",
      perAgent: { "ARCS Orchestrator": "special/orchestrator" },
    });

    const result = JSON.parse(await readFile(configFile, "utf-8"));
    expect(result.agent["ARCS Orchestrator"].model).toBe("special/orchestrator");
    // Caveman has no override — falls back to standard tier
    expect(result.agent["ARCS Caveman"].model).toBe("mid/model");
  });

  it("replaces stale model on primary agents with current tier value", async () => {
    const config = {
      agent: {
        "ARCS Orchestrator": { prompt: "test", model: "old/model" },
        "ARCS Caveman": { prompt: "test", model: "old/model" },
      },
    };
    writeFileSync(configFile, JSON.stringify(config));

    applyAgentModelConfig({ heavy: "big/model", standard: "mid/model", light: "small/model" });

    const result = JSON.parse(await readFile(configFile, "utf-8"));
    // Both primary agents are standard tier — old model is replaced, not removed
    expect(result.agent["ARCS Orchestrator"].model).toBe("mid/model");
    expect(result.agent["ARCS Caveman"].model).toBe("mid/model");
  });

  it("skips agents not in tier map", async () => {
    const config = {
      agent: {
        "unknown-agent": { prompt: "mystery" },
        explore: { prompt: "explore" },
      },
    };
    writeFileSync(configFile, JSON.stringify(config));

    applyAgentModelConfig({ heavy: "big/model", standard: "mid/model", light: "small/model" });

    const result = JSON.parse(await readFile(configFile, "utf-8"));
    // unknown-agent is not in AGENT_TIER_MAP and not a primary — no model field set
    expect(result.agent["unknown-agent"].model).toBeUndefined();
    // explore IS in tier map
    expect(result.agent.explore.model).toBe("small/model");
  });
});

// ---------------------------------------------------------------------------
// D. Integration: writeOpencodeAgent with model config
// ---------------------------------------------------------------------------

describe("writeOpencodeAgent with modelConfig", () => {
  let tempDir: string;
  let originalHome: string | undefined;
  let configDir: string;
  let configFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "arcs-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
    configDir = join(tempDir, ".config", "opencode");
    configFile = join(configDir, "opencode.json");
    mkdirSync(configDir, { recursive: true });
    // Seed an empty config
    writeFileSync(configFile, JSON.stringify({}));
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempDir, { recursive: true });
  });

  it("sets standard tier model on primary agents without perAgent override", async () => {
    writeOpencodeAgent({ heavy: "big/m", standard: "mid/m", light: "sm/m" });

    const result = JSON.parse(await readFile(configFile, "utf-8"));
    expect(result.agent["ARCS Orchestrator"].model).toBe("mid/m");
    expect(result.agent["ARCS Caveman"].model).toBe("mid/m");
  });

  it("sets model on primary agents with perAgent override", async () => {
    writeOpencodeAgent({
      heavy: "big/m",
      standard: "mid/m",
      light: "sm/m",
      perAgent: { "ARCS Orchestrator": "override/orch" },
    });

    const result = JSON.parse(await readFile(configFile, "utf-8"));
    expect(result.agent["ARCS Orchestrator"].model).toBe("override/orch");
    // Caveman falls back to standard tier
    expect(result.agent["ARCS Caveman"].model).toBe("mid/m");
  });

  it("creates config file if it does not exist", async () => {
    // Remove the seeded file
    const { unlink } = await import("node:fs/promises");
    await unlink(configFile);

    const result = writeOpencodeAgent();
    expect(result.action).toBe("created");
  });
});
