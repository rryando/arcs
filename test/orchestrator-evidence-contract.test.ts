import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FLASH_PROMPT_TEXT } from "../src/cli/arcs-flash.js";
import { ORCHESTRATE_PROMPT_TEXT } from "../src/cli/arcs-orchestrate.js";
import { ORCHESTRATE_CAVEMAN_PROMPT_TEXT } from "../src/cli/arcs-orchestrate-caveman.js";

const read = (path: string) => readFileSync(resolve(import.meta.dirname, "..", path), "utf8");

describe("orchestrator evidence contract (static, not live behavior)", () => {
  it.each([
    ORCHESTRATE_PROMPT_TEXT,
    FLASH_PROMPT_TEXT,
    ORCHESTRATE_CAVEMAN_PROMPT_TEXT,
  ])("enforces routing and evidence without implementation rereads", (prompt) => {
    for (const contract of [
      /zero implementation-source reads/i,
      /source-returning codegraph and source-bearing diffs/i,
      /user-authorized git bookkeeping stays direct/i,
      /no plan ID: no worktree ceremony/i,
      /do not edit code/i,
      /unknown files.*valid.*bounded discovery/is,
      /host.*opt-in.*capabilities/is,
      /serializ.*shared-file edits/is,
      /do not wait for all/i,
      /missing evidence.*owner/is,
      /independent.*code-reviewer.*material risk.*contradictions/is,
      /acceptance coverage/i,
      /not-run/i,
      /examined.*changed/is,
      /single.*owner.*task\/diagram/is,
      /persisted ID.*already covered.*deferred/is,
    ])
      expect(prompt).toMatch(contract);
    expect(prompt).not.toMatch(
      /work directly when small|keep small cohesive work direct|wait for all delegates|no.*reviewer → repair chains/i,
    );
  });

  it.each([
    "graph-explorer",
    "tech-architect",
    "software-engineer",
    "code-reviewer",
    "arcs-docs",
  ])("requires decision-ready returns from %s", (role) => {
    const prompt = read(`opencode/arcs/prompts/${role}.txt`);
    for (const contract of [
      /no nested delegation/i,
      /acceptance coverage/i,
      /claim-linked/i,
      /examined.*changed/is,
      /command.*result.*working directory/is,
      /not-run/i,
      /create\/update.*ID/is,
      /stale.*conflicting/is,
    ])
      expect(prompt).toMatch(contract);
  });

  it("keeps the five-role roster and metadata permissions without a forced pipeline", () => {
    const manifest = JSON.parse(read("opencode/arcs/manifest.json"));
    const active = manifest.agents.filter((agent: { status: string }) => agent.status === "active");
    const workers = active.filter((agent: { kind: string }) => agent.kind === "subagent");
    expect(workers).toHaveLength(5);
    for (const worker of workers) expect(worker.permissions.task).toBe("deny");
    for (const main of active.filter((agent: { kind: string }) => agent.kind === "primary")) {
      expect(main.permissions.bash).toBe("allow");
      expect(main.permissions.mcp).toBe("allow");
      expect(main.description).toMatch(/no implementation-source reads/i);
    }
  });

  it("keeps source-bearing reference techniques inside specialist roles", () => {
    for (const path of [
      "opencode/arcs/skills/brainstorming/SKILL.md",
      "opencode/arcs/skills/implementation/SKILL.md",
      "opencode/arcs/skills/caveman-commit/SKILL.md",
      "opencode/arcs/skills/writing-proposals/SKILL.md",
      "opencode/arcs/skills/enriching-codegraph-proposals/SKILL.md",
      "skills/orchestrate.md",
    ])
      expect(read(path)).toMatch(
        /main.*(?:delegat|not permission|not reading|zero implementation-source reads)|not permission for main/is,
      );
    const readme = read("README.md");
    expect(readme).toMatch(/five typed sub-agents/i);
    expect(readme).not.toMatch(/exactly one targeted knowledge search|tiny work.*may stay direct/i);
  });

  it("closes knowledge disposition with freshness and authorized ownership", () => {
    const skill = read("opencode/arcs/skills/writing-knowledge/SKILL.md");
    for (const contract of [
      /dedup/i,
      /revision/i,
      /validate.*locally/is,
      /summary.*body.*synchron/is,
      /persisted ID.*already covered.*deferred/is,
      /arcs-docs/i,
      /not.*every task/i,
    ])
      expect(skill).toMatch(contract);
  });
});
