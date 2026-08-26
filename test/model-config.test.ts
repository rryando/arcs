import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getActiveAgents,
  getAgentTierMap,
  readAgentRegistry,
  validateAgentRegistry,
} from "../src/cli/agent-registry.js";
import {
  diagnoseClaudeCodeBundle,
  diagnoseOpenCodeConfig,
  extractModelPreFills,
  readConfigOrDefault,
  readOpenCodeConfig,
} from "../src/cli/config.js";
import { applyAgentModelConfig, writeOpencodeAgent } from "../src/cli/instructions.js";
import { agentRegistryRecordSchema } from "../src/utils/json-schemas.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

describe("agent registry", () => {
  it("reads the package manifest as the canonical typed registry", () => {
    const registry = readAgentRegistry();
    const activeAgents = getActiveAgents(registry);

    expect(activeAgents).toHaveLength(8);
    expect(activeAgents.every((agent) => agent.status === "active")).toBe(true);
    expect(
      activeAgents.filter((agent) => agent.kind === "subagent").map((agent) => agent.id),
    ).toEqual([
      "software-engineer",
      "tech-architect",
      "arcs-docs",
      "code-reviewer",
      "graph-explorer",
    ]);
    expect(registry.agents.find((agent) => agent.id === "oncall-ops")).toMatchObject({
      status: "retired",
      replacementId: "software-engineer",
    });
    expect(registry.agents.find((agent) => agent.id === "docs-researcher")).toMatchObject({
      status: "retired",
      replacementId: "tech-architect",
    });
    expect(registry.agents.find((agent) => agent.id === "devil-advocate")).toMatchObject({
      status: "retired",
      replacementId: "code-reviewer",
    });
    expect(
      activeAgents
        .filter((agent) => agent.kind === "subagent")
        .every((agent) => agent.permissions.task === "deny"),
    ).toBe(true);
    expect(activeAgents.find((agent) => agent.id === "software-engineer")).toMatchObject({
      kind: "subagent",
      tier: "heavy",
      source: "prompts/software-engineer.txt",
      destination: "prompts/software-engineer.txt",
      permissions: { edit: "allow" },
    });
  });

  it("derives ARCS tier assignments from manifest records", () => {
    expect(getAgentTierMap()).toMatchObject({
      "software-engineer": "heavy",
      "tech-architect": "heavy",
      "code-reviewer": "standard",
      "graph-explorer": "light",
      "arcs-orchestrate": "standard",
      "arcs-flash": "standard",
    });
    expect(getAgentTierMap()).not.toHaveProperty("devil-advocate");
  });

  it.each([
    ["traversal source", { source: "prompts/../outside.txt" }],
    ["absolute source", { source: "/tmp/outside.txt" }],
    ["empty destination segment", { destination: "prompts//software-engineer.txt" }],
    ["dot destination segment", { destination: "prompts/./software-engineer.txt" }],
    ["non-txt destination", { destination: "prompts/software-engineer.md" }],
    ["malformed id", { id: "../software-engineer" }],
  ])("rejects %s in typed registry records", (_label, overrides) => {
    const record = {
      id: "software-engineer",
      status: "active",
      kind: "subagent",
      tier: "heavy",
      modes: ["opencode", "claudecode"],
      source: "prompts/software-engineer.txt",
      destination: "prompts/software-engineer.txt",
      description: "Implementation specialist",
      permissions: {
        edit: "allow",
        bash: "allow",
        webfetch: "allow",
        mcp: "allow",
        task: "deny",
      },
      ...overrides,
    };

    expect(agentRegistryRecordSchema.safeParse(record).success).toBe(false);
  });

  it.each([
    ["has no replacement", undefined, "active", "subagent", ["opencode", "claudecode"]],
    [
      "names a missing replacement",
      "missing-agent",
      "active",
      "subagent",
      ["opencode", "claudecode"],
    ],
    [
      "names a retired replacement",
      "replacement",
      "retired",
      "subagent",
      ["opencode", "claudecode"],
    ],
    ["changes agent kind", "replacement", "active", "primary", ["opencode", "claudecode"]],
    ["drops a supported mode", "replacement", "active", "subagent", ["opencode"]],
  ] as const)("rejects a retired agent that %s", (_label, replacementId, status, kind, modes) => {
    const base = readAgentRegistry().agents.find((agent) => agent.id === "software-engineer");
    if (!base) throw new Error("missing fixture agent");
    const retired = {
      ...base,
      id: "retired-agent",
      status: "retired" as const,
      replacementId,
      source: "prompts/retired-agent.txt",
      destination: "prompts/retired-agent.txt",
    };
    const replacement = {
      ...base,
      id: "replacement",
      status,
      kind,
      modes: [...modes],
      source: "prompts/replacement.txt",
      destination: "prompts/replacement.txt",
    };

    expect(() => validateAgentRegistry({ agents: [retired, replacement] })).toThrow(
      /retired agent.*replacement/i,
    );
  });
});

describe("ARCS setup config", () => {
  it("recovers from a schema-invalid persisted config", async () => {
    await withTempDataDir(async (dataDir) => {
      writeFileSync(join(dataDir, "config.json"), JSON.stringify({ version: "1", ides: "bad" }));
      expect(readConfigOrDefault()).toEqual({ version: "1", ides: [] });
    });
  });
});

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

  it("does not infer variants from a legacy agent model override", () => {
    expect(
      extractModelPreFills({
        model: "foo/bar",
        agent: { "tech-architect": { model: "legacy/override" } },
      }),
    ).toEqual({
      heavy: "foo/bar",
      standard: "foo/bar",
      light: "foo/bar",
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
// B3. diagnoseClaudeCodeBundle — reads back tierModels from the installed manifest
// ---------------------------------------------------------------------------

describe("diagnoseClaudeCodeBundle", () => {
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

  async function writeManifest(content: unknown): Promise<void> {
    const claudeDir = join(tempDir, ".claude");
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, ".arcs-bundle.json"),
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }

  const installedAgents = [
    { id: "arcs-orchestrate", promptDestination: "agents/arcs-orchestrate.md", sourceHash: "abc" },
  ];

  it("reports 'missing' when the manifest does not exist", async () => {
    const result = await diagnoseClaudeCodeBundle();
    expect(result.status).toBe("missing");
  });

  it("reports 'ok' with tierModels when all three tiers are present", async () => {
    await writeManifest({
      bundleId: "arcs-claudecode-bundle",
      agents: installedAgents,
      tierModels: { heavy: "big/model", standard: "mid/model", light: "small/model" },
    });
    const result = await diagnoseClaudeCodeBundle();
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.tierModels).toEqual({
        heavy: "big/model",
        standard: "mid/model",
        light: "small/model",
      });
    }
  });

  it("reports 'corrupt' when the manifest exists but is invalid JSON", async () => {
    await writeManifest('{ "bundleId": "arcs-claudecode-bundle"');
    const result = await diagnoseClaudeCodeBundle();
    expect(result.status).toBe("corrupt");
    if (result.status === "corrupt") {
      expect(result.error).toBeTruthy();
    }
  });

  it("reports 'missing' for valid JSON that is not an ARCS bundle manifest", async () => {
    await writeManifest({});
    expect((await diagnoseClaudeCodeBundle()).status).toBe("missing");

    await writeManifest({
      bundleId: "some-other-tool-bundle",
      agents: installedAgents,
      tierModels: { heavy: "big/model", standard: "mid/model", light: "small/model" },
    });
    expect((await diagnoseClaudeCodeBundle()).status).toBe("missing");
  });

  it("reports 'missing' when the manifest has no installed agents", async () => {
    await writeManifest({ bundleId: "arcs-claudecode-bundle", agents: [] });
    const result = await diagnoseClaudeCodeBundle();
    expect(result.status).toBe("missing");
  });

  it("reports 'ok' without tierModels when the field is absent entirely", async () => {
    // A bundle deployed before tierModels was persisted.
    await writeManifest({ bundleId: "arcs-claudecode-bundle", agents: installedAgents });
    const result = await diagnoseClaudeCodeBundle();
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.tierModels).toBeUndefined();
      expect("tierModels" in result).toBe(false);
    }
  });

  it("reports 'ok' without tierModels when only some tiers are populated", async () => {
    // All-or-nothing: a partial selection must never produce a partial substitution.
    await writeManifest({
      bundleId: "arcs-claudecode-bundle",
      agents: installedAgents,
      tierModels: { heavy: "big/model", standard: "mid/model", light: "" },
    });
    const emptyLight = await diagnoseClaudeCodeBundle();
    expect(emptyLight.status).toBe("ok");
    if (emptyLight.status === "ok") {
      expect(emptyLight.tierModels).toBeUndefined();
    }

    await writeManifest({
      bundleId: "arcs-claudecode-bundle",
      agents: installedAgents,
      tierModels: { heavy: "big/model", standard: "mid/model" },
    });
    const missingLight = await diagnoseClaudeCodeBundle();
    expect(missingLight.status).toBe("ok");
    if (missingLight.status === "ok") {
      expect(missingLight.tierModels).toBeUndefined();
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
        "graph-explorer": { prompt: "explore things" },
        "software-engineer": { prompt: "code stuff" },
        build: { prompt: "build stuff" },
      },
    };
    writeFileSync(configFile, JSON.stringify(config));

    applyAgentModelConfig({ heavy: "big/model", standard: "mid/model", light: "small/model" });

    const result = JSON.parse(await readFile(configFile, "utf-8"));
    // Sub-agents get tier models
    expect(result.agent["graph-explorer"].model).toBe("small/model");
    expect(result.agent["software-engineer"].model).toBe("big/model");
    expect(result.agent.build.model).toBe("mid/model");
    // Primary agents are standard tier
    expect(result.agent["ARCS Orchestrator"].model).toBe("mid/model");
    expect(result.agent["ARCS Caveman"].model).toBe("mid/model");
    expect(result.agent["ARCS Orchestrator"].variant).toBe("none");
    expect(result.agent["graph-explorer"].variant).toBe("none");
  });

  it("applies perAgent override to sub-agents", async () => {
    const config = {
      agent: {
        "graph-explorer": { prompt: "explore" },
        "software-engineer": { prompt: "code" },
      },
    };
    writeFileSync(configFile, JSON.stringify(config));

    applyAgentModelConfig({
      heavy: "big/model",
      standard: "mid/model",
      light: "small/model",
      perAgent: { "graph-explorer": "custom/explorer" },
    });

    const result = JSON.parse(await readFile(configFile, "utf-8"));
    expect(result.agent["graph-explorer"].model).toBe("custom/explorer");
    expect(result.agent["software-engineer"].model).toBe("big/model");
  });

  it("applies per-tier OpenCode variants with a default of none", async () => {
    const config = {
      agent: {
        "tech-architect": { prompt: "architect" },
      },
    };
    writeFileSync(configFile, JSON.stringify(config));

    applyAgentModelConfig({
      heavy: "big/model",
      standard: "mid/model",
      light: "small/model",
      variants: { heavy: "max", standard: "high", light: "none" },
    });

    const result = JSON.parse(await readFile(configFile, "utf-8"));
    expect(result.agent["tech-architect"].model).toBe("big/model");
    expect(result.agent["tech-architect"].variant).toBe("max");
  });

  it("preserves a perAgent model override while applying its tier variant", async () => {
    const config = {
      agent: {
        "tech-architect": { prompt: "architect" },
      },
    };
    writeFileSync(configFile, JSON.stringify(config));

    applyAgentModelConfig({
      heavy: "big/model",
      standard: "mid/model",
      light: "small/model",
      variants: { heavy: "max", standard: "high", light: "none" },
      perAgent: { "tech-architect": "custom/architect" },
    });

    const result = JSON.parse(await readFile(configFile, "utf-8"));
    expect(result.agent["tech-architect"].model).toBe("custom/architect");
    expect(result.agent["tech-architect"].variant).toBe("max");
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
        explore: { prompt: "legacy explore" },
        "graph-explorer": { prompt: "explore" },
      },
    };
    writeFileSync(configFile, JSON.stringify(config));

    applyAgentModelConfig({ heavy: "big/model", standard: "mid/model", light: "small/model" });

    const result = JSON.parse(await readFile(configFile, "utf-8"));
    // unknown-agent is not in AGENT_TIER_MAP and not a primary — no model field set
    expect(result.agent["unknown-agent"].model).toBeUndefined();
    // Legacy explore config is tolerated but not actively assigned a model.
    expect(result.agent.explore.model).toBeUndefined();
    // graph-explorer is the active light-tier agent.
    expect(result.agent["graph-explorer"].model).toBe("small/model");
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
    expect(result.agent["ARCS Flash"].model).toBe("mid/m");
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
