import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FLASH_PROMPT_TEXT } from "../src/cli/arcs-flash.js";
import { ORCHESTRATE_PROMPT_TEXT } from "../src/cli/arcs-orchestrate.js";
import {
  CAVEMAN_PREAMBLE,
  ORCHESTRATE_CAVEMAN_PROMPT_TEXT,
} from "../src/cli/arcs-orchestrate-caveman.js";
import { writeOpencodeAgent } from "../src/cli/instructions.js";
import { withTempHomeDir } from "./helpers/temp-home-dir.js";

describe("writeOpencodeAgent — agent key order", () => {
  it("places ARCS Orchestrator, ARCS Flash, then ARCS Caveman in a fresh config", async () => {
    await withTempHomeDir(async (homeDir) => {
      writeOpencodeAgent();

      const configFile = resolve(homeDir, ".config", "opencode", "opencode.json");
      const raw = readFileSync(configFile, "utf-8");
      const config = JSON.parse(raw) as Record<string, unknown>;
      const agentKeys = Object.keys(config.agent as object);

      expect(agentKeys[0]).toBe("ARCS Orchestrator");
      expect(agentKeys[1]).toBe("ARCS Flash");
      expect(agentKeys[2]).toBe("ARCS Caveman");
    });
  });

  it("places ARCS agents first and build fourth when existing config has build and plan", async () => {
    await withTempHomeDir(async (homeDir) => {
      const configFile = resolve(homeDir, ".config", "opencode", "opencode.json");
      const existing = {
        $schema: "https://opencode.ai/config.json",
        agent: {
          build: { model: "some-model" },
          plan: { model: "another-model" },
          general: { model: "third-model" },
        },
      };
      writeFileSync(configFile, JSON.stringify(existing, null, 2));

      writeOpencodeAgent();

      const raw = readFileSync(configFile, "utf-8");
      const config = JSON.parse(raw) as Record<string, unknown>;
      const agentKeys = Object.keys(config.agent as object);

      expect(agentKeys[0]).toBe("ARCS Orchestrator");
      expect(agentKeys[1]).toBe("ARCS Flash");
      expect(agentKeys[2]).toBe("ARCS Caveman");
      expect(agentKeys[3]).toBe("build");
    });
  });

  it("preserves all existing agent configs when reordering", async () => {
    await withTempHomeDir(async (homeDir) => {
      const configFile = resolve(homeDir, ".config", "opencode", "opencode.json");
      const existing = {
        agent: {
          plan: { model: "opus" },
          build: { model: "sonnet" },
        },
      };
      writeFileSync(configFile, JSON.stringify(existing, null, 2));

      writeOpencodeAgent();

      const raw = readFileSync(configFile, "utf-8");
      const config = JSON.parse(raw) as Record<string, unknown>;
      const agents = config.agent as Record<string, unknown>;

      expect((agents.build as any).model).toBe("sonnet");
      expect((agents.plan as any).model).toBe("opus");
      expect(agents["ARCS Orchestrator"]).toBeDefined();
      expect(agents["ARCS Flash"]).toBeDefined();
      expect(agents["ARCS Caveman"]).toBeDefined();
    });
  });

  it("does not duplicate ARCS agents if already present", async () => {
    await withTempHomeDir(async (homeDir) => {
      writeOpencodeAgent();
      writeOpencodeAgent();

      const configFile = resolve(homeDir, ".config", "opencode", "opencode.json");
      const raw = readFileSync(configFile, "utf-8");
      const config = JSON.parse(raw) as Record<string, unknown>;
      const agentKeys = Object.keys(config.agent as object);

      const orchestratorCount = agentKeys.filter((k) => k === "ARCS Orchestrator").length;
      const flashCount = agentKeys.filter((k) => k === "ARCS Flash").length;
      const cavemanCount = agentKeys.filter((k) => k === "ARCS Caveman").length;
      expect(orchestratorCount).toBe(1);
      expect(flashCount).toBe(1);
      expect(cavemanCount).toBe(1);
      expect(agentKeys[0]).toBe("ARCS Orchestrator");
      expect(agentKeys[1]).toBe("ARCS Flash");
      expect(agentKeys[2]).toBe("ARCS Caveman");
    });
  });

  it("sets default_agent to ARCS Orchestrator (Caveman is opt-in)", async () => {
    await withTempHomeDir(async (homeDir) => {
      writeOpencodeAgent();

      const configFile = resolve(homeDir, ".config", "opencode", "opencode.json");
      const raw = readFileSync(configFile, "utf-8");
      const config = JSON.parse(raw) as Record<string, unknown>;

      expect(config.default_agent).toBe("ARCS Orchestrator");
    });
  });

  it("honors an explicit primary agent id without changing key order", async () => {
    await withTempHomeDir(async (homeDir) => {
      writeOpencodeAgent(undefined, "arcs-orchestrate-caveman");

      const configFile = resolve(homeDir, ".config", "opencode", "opencode.json");
      const raw = readFileSync(configFile, "utf-8");
      const config = JSON.parse(raw) as Record<string, unknown>;
      const agentKeys = Object.keys(config.agent as object);

      expect(config.default_agent).toBe("ARCS Caveman");
      expect(agentKeys.slice(0, 3)).toEqual(["ARCS Orchestrator", "ARCS Flash", "ARCS Caveman"]);
    });
  });

  it("falls back to ARCS Orchestrator for an unknown primary agent id", async () => {
    await withTempHomeDir(async (homeDir) => {
      writeOpencodeAgent(undefined, "not-a-registered-primary");

      const configFile = resolve(homeDir, ".config", "opencode", "opencode.json");
      const raw = readFileSync(configFile, "utf-8");
      const config = JSON.parse(raw) as Record<string, unknown>;

      expect(config.default_agent).toBe("ARCS Orchestrator");
    });
  });

  it("registers ARCS Flash as a primary agent pointing at its prompt file", async () => {
    await withTempHomeDir(async (homeDir) => {
      writeOpencodeAgent();

      const configFile = resolve(homeDir, ".config", "opencode", "opencode.json");
      const raw = readFileSync(configFile, "utf-8");
      const config = JSON.parse(raw) as Record<string, unknown>;
      const agents = config.agent as Record<string, any>;

      expect(agents["ARCS Flash"].mode).toBe("primary");
      expect(agents["ARCS Flash"].prompt).toBe("{file:./prompts/arcs-flash.txt}");
      expect(agents["ARCS Flash"].description).toContain("speed-optimized orchestrator");
    });
  });

  it("writes all three orchestrator prompt files to disk", async () => {
    await withTempHomeDir(async (homeDir) => {
      writeOpencodeAgent();

      const orchestratorPrompt = resolve(
        homeDir,
        ".config",
        "opencode",
        "prompts",
        "arcs-orchestrate.txt",
      );
      const flashPrompt = resolve(homeDir, ".config", "opencode", "prompts", "arcs-flash.txt");
      const cavemanPrompt = resolve(
        homeDir,
        ".config",
        "opencode",
        "prompts",
        "arcs-orchestrate-caveman.txt",
      );

      const orchestratorContent = readFileSync(orchestratorPrompt, "utf-8");
      const flashContent = readFileSync(flashPrompt, "utf-8");
      const cavemanContent = readFileSync(cavemanPrompt, "utf-8");

      expect(orchestratorContent).toBe(`${ORCHESTRATE_PROMPT_TEXT}\n`);
      expect(flashContent).toBe(`${FLASH_PROMPT_TEXT}\n`);
      expect(cavemanContent).toBe(`${ORCHESTRATE_CAVEMAN_PROMPT_TEXT}\n`);
    });
  });
});

describe("Caveman narration overlay behavior", () => {
  it("limits Caveman behavior to chat-facing narration", () => {
    expect(CAVEMAN_PREAMBLE).toContain("narration-only overlay");
    expect(CAVEMAN_PREAMBLE).toMatch(/no workflow or mutation authority/i);
    expect(CAVEMAN_PREAMBLE).toMatch(/chat terse/i);
  });

  it("composes the canonical control flow without replacing or rewriting it", () => {
    expect(ORCHESTRATE_CAVEMAN_PROMPT_TEXT).toBe(CAVEMAN_PREAMBLE + ORCHESTRATE_PROMPT_TEXT);
    expect(ORCHESTRATE_CAVEMAN_PROMPT_TEXT.endsWith(ORCHESTRATE_PROMPT_TEXT)).toBe(true);
  });

  it("preserves current safety requirements exactly", () => {
    const protectedRequirements = [
      "untrusted reference data",
      "Confirm destructive, irreversible, or remote effects",
      "git commit",
      "Never claim verification you did not run",
    ];

    for (const requirement of protectedRequirements) {
      expect(ORCHESTRATE_PROMPT_TEXT).toContain(requirement);
      expect(ORCHESTRATE_CAVEMAN_PROMPT_TEXT.slice(CAVEMAN_PREAMBLE.length)).toContain(requirement);
    }
    expect(CAVEMAN_PREAMBLE).toMatch(/never compress safety warnings.*confirmations/is);
  });

  it("preserves guarded mode and explicit Git safeguards", () => {
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/guarded-mode tokens.*authoritative/i);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(
      /git add.*git commit.*git push.*explicit user request/is,
    );
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/destructive.*remote effects/is);
  });

  it("does not define independent routing or dispatch authority", () => {
    expect(CAVEMAN_PREAMBLE).toMatch(/no workflow or mutation authority/i);
    expect(CAVEMAN_PREAMBLE).not.toMatch(
      /software-engineer|tech-architect|graph-explorer|code-reviewer|devil-advocate|arcs-docs/,
    );
    expect(CAVEMAN_PREAMBLE).not.toMatch(/## (Dispatch|Lifecycle|Workflow|Retry|Agent)/);
  });

  it("has correct agent metadata for ARCS Orchestrator and Caveman", async () => {
    await withTempHomeDir(async (homeDir) => {
      writeOpencodeAgent();

      const configFile = resolve(homeDir, ".config", "opencode", "opencode.json");
      const raw = readFileSync(configFile, "utf-8");
      const config = JSON.parse(raw) as Record<string, unknown>;
      const agents = config.agent as Record<string, any>;

      expect(agents["ARCS Orchestrator"].color).toBe("#00bcd4");
      expect(agents["ARCS Orchestrator"].mode).toBe("primary");
      expect(agents["ARCS Caveman"].color).toBe("#d2691e");
      expect(agents["ARCS Caveman"].mode).toBe("primary");
      expect(agents["ARCS Caveman"].description).toContain("terse");
      expect(agents["ARCS Caveman"].description).toContain("high-efficiency");
    });
  });

  it("caveman prompt file starts with CAVEMAN_PREAMBLE", async () => {
    await withTempHomeDir(async (homeDir) => {
      writeOpencodeAgent();

      const cavemanPrompt = resolve(
        homeDir,
        ".config",
        "opencode",
        "prompts",
        "arcs-orchestrate-caveman.txt",
      );
      const content = readFileSync(cavemanPrompt, "utf-8");
      expect(content.startsWith(CAVEMAN_PREAMBLE)).toBe(true);
    });
  });
});
