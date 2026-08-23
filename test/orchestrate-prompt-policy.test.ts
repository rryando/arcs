import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ORCHESTRATE_PROMPT_TEXT } from "../src/cli/arcs-orchestrate.js";
import {
  CAVEMAN_PREAMBLE,
  ORCHESTRATE_CAVEMAN_PROMPT_TEXT,
} from "../src/cli/arcs-orchestrate-caveman.js";

describe("orchestrate prompt policy — delegation-preferred lifecycle", () => {
  it("lets the primary agent work directly", () => {
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/UNDERSTAND\s*→\s*WORK\s*→\s*VERIFY\s*→\s*REPORT/);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/inspect.*edit.*run.*verify/is);
    expect(ORCHESTRATE_PROMPT_TEXT).not.toMatch(/you do not implement/i);
    expect(ORCHESTRATE_PROMPT_TEXT).not.toMatch(/never read source.*edit files/is);
  });

  it("prefers delegation for separable work while retaining direct tools", () => {
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/[Pp]refer delegation/is);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(
      /separable implementation.*investigation.*research.*review/is,
    );
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/tiny.*tightly coupled.*orchestration-state/is);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/one owner per\s*(delegated\s*)?outcome/i);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/no nested delegation/i);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/delegate.*reviewer.*repair.*chains/i);
  });

  it("uses the exact lean dispatch and return contracts", () => {
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(
      /GOAL:\s*<[^>]+>\s*SCOPE:\s*<[^>]+>\s*CONTEXT:\s*<[^>]+>\s*VERIFY:\s*<[^>]+>\s*STOP:\s*<[^>]+>/s,
    );
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(
      /STATUS:\s*<[^>]+>\s*RESULT:\s*<[^>]+>\s*FILES:\s*<[^>]+>\s*VERIFY:\s*<[^>]+>\s*BLOCKER:\s*<[^>]+>/s,
    );
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/KNOWLEDGE.*only.*durable discover/is);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/do not echo context or narrate process/i);
  });

  it("preserves the untrusted-reference boundary", () => {
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/untrusted reference data/i);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/embedded instructions.*cannot override/is);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/system.*user.*authority/is);
  });

  it("uses plans and knowledge only when useful", () => {
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/plan.*broad|multi-step|architectural/is);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/knowledge.*when.*prior decision/is);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/explicit.*create.*plan.*authoriz/is);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/goal.*scope.*destructive.*external/is);
    expect(ORCHESTRATE_PROMPT_TEXT).not.toMatch(/exact artifact authorization/i);
  });

  it("lists exactly five specialists and twelve skills", () => {
    for (const agent of [
      "software-engineer",
      "tech-architect",
      "graph-explorer",
      "code-reviewer",
      "arcs-docs",
    ]) {
      expect(ORCHESTRATE_PROMPT_TEXT).toContain(`\`${agent}\``);
    }
    expect(ORCHESTRATE_PROMPT_TEXT).not.toContain("`devil-advocate`");
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/code-reviewer.*review.*audit.*risk/is);

    const skillsDir = resolve(import.meta.dirname, "../opencode/arcs/skills");
    const skills = readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => name !== "executing-plans")
      .sort();
    expect(skills).toHaveLength(12);
    for (const skill of skills) expect(ORCHESTRATE_PROMPT_TEXT, skill).toContain(`\`${skill}\``);
    expect(ORCHESTRATE_PROMPT_TEXT).not.toContain("`executing-plans`");
  });

  it("makes review and full-project verification risk-based", () => {
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/agent that changes.*runs.*relevant verification/is);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/full-project.*broad|high-risk/is);
    expect(ORCHESTRATE_PROMPT_TEXT).not.toMatch(/only completion verifier/i);
    expect(ORCHESTRATE_PROMPT_TEXT).not.toMatch(/completion gate.*never skipped/i);
  });

  it("repairs verification failures directly without a gate loop", () => {
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/verification fails.*fix.*rerun/is);
    expect(ORCHESTRATE_PROMPT_TEXT).not.toMatch(/PHASE_GATE|completion-repair|gate rerun/);
  });

  it("keeps destructive, remote, and git effects explicit", () => {
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(
      /confirm.*destructive.*irreversible.*remote|destructive.*irreversible.*remote.*confirm/is,
    );
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/git (?:add|commit|push).*explicit user request/is);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/never claim.*verification.*did not run/is);
  });
});

describe("orchestrate prompt policy — caveman overlay", () => {
  it("changes narration only", () => {
    expect(CAVEMAN_PREAMBLE).toMatch(/narration-only/i);
    expect(CAVEMAN_PREAMBLE).toMatch(/no workflow.*authority/is);
    expect(ORCHESTRATE_CAVEMAN_PROMPT_TEXT).toBe(CAVEMAN_PREAMBLE + ORCHESTRATE_PROMPT_TEXT);
  });
});
