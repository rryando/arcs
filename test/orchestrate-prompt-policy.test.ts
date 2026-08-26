import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FLASH_PROMPT_TEXT } from "../src/cli/arcs-flash.js";
import { ORCHESTRATE_PROMPT_TEXT } from "../src/cli/arcs-orchestrate.js";
import {
  CAVEMAN_PREAMBLE,
  ORCHESTRATE_CAVEMAN_PROMPT_TEXT,
} from "../src/cli/arcs-orchestrate-caveman.js";

describe("orchestrate prompt policy — dispatch-first lifecycle", () => {
  it("uses the PARSE → DISPATCH → COLLECT → SYNTHESIZE → REPORT lifecycle", () => {
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(
      /PARSE\s*→\s*DISPATCH\s*→\s*COLLECT\s*→\s*SYNTHESIZE\s*→\s*REPORT/,
    );
    expect(ORCHESTRATE_PROMPT_TEXT).not.toMatch(/UNDERSTAND\s*→\s*WORK/);
  });

  it("identifies as orchestrator, not direct implementer", () => {
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/orchestrator/i);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/dispatch.*not implement/i);
    expect(ORCHESTRATE_PROMPT_TEXT).not.toMatch(/you do not implement/i);
    expect(ORCHESTRATE_PROMPT_TEXT).not.toMatch(/never read source.*edit files/is);
  });

  it("delegates aggressively via routing tiers", () => {
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/delegate aggressively/i);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(
      /Explore.*Investigate.*graph-explorer.*tech-architect.*oncall-ops.*qa-analyst/is,
    );
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/Implement.*Fix.*software-engineer/is);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/DAG.*Knowledge.*arcs-docs/is);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/Review.*Audit.*code-reviewer/is);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/Research.*Synthesize.*docs-researcher/is);
  });

  it("covers special-case direct work", () => {
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/tiny tightly coupled/i);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/orchestration-state/i);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/final synthesis.*reporting/i);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/one owner per outcome/i);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/no nested delegation/i);
  });

  it("routes independent units in parallel", () => {
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/parallel/i);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/wait for all.*return/i);
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
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/delegate plan creation/i);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/explicit.*create.*plan.*authoriz/is);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/goal.*scope.*destructive.*external/is);
    expect(ORCHESTRATE_PROMPT_TEXT).not.toMatch(/exact artifact authorization/i);
  });

  it("lists exactly twelve skills (agent list replaced by routing table)", () => {
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

  it("makes review risk-based with code-reviewer in routing table", () => {
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/Review\s*\/\s*Audit.*code-reviewer/is);
    expect(ORCHESTRATE_PROMPT_TEXT).not.toMatch(/only completion verifier/i);
    expect(ORCHESTRATE_PROMPT_TEXT).not.toMatch(/completion gate.*never skipped/i);
  });

  it("keeps destructive, remote, and git effects explicit", () => {
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(
      /confirm.*destructive.*irreversible.*remote|destructive.*irreversible.*remote.*confirm/is,
    );
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/git (?:add|commit|push).*explicit user request/is);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/never claim.*verification.*did not run/is);
  });
});

describe("orchestrate prompt policy — plan worktree discipline", () => {
  it("ensures a plan worktree before dispatching implementation", () => {
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/arcs worktree ensure <slug> <planId>/);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/returned path verbatim in SCOPE/is);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/confine delegate edits\/tests to it/i);
  });

  it("never dispatches implementation against the main checkout when a tree exists", () => {
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(
      /never dispatch implementation against the main checkout/i,
    );
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/parallel plans get parallel trees/i);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/never share one/i);
  });

  it("gates task completion on worktree validation and skips non-git repos", () => {
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/arcs worktree validate <slug>/);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/non-zero exit blocks `arcs done`/i);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/non-git repos: skip silently/i);
  });

  it("carries the ensure/validate minimum into flash", () => {
    expect(FLASH_PROMPT_TEXT).toMatch(/arcs worktree ensure <slug> <planId>/);
    expect(FLASH_PROMPT_TEXT).toMatch(/arcs worktree validate <slug>/);
    expect(FLASH_PROMPT_TEXT).toMatch(/never dispatch implementation against the main checkout/i);
  });
});

describe("orchestrate prompt policy — caveman overlay", () => {
  it("changes narration only", () => {
    expect(CAVEMAN_PREAMBLE).toMatch(/narration-only/i);
    expect(CAVEMAN_PREAMBLE).toMatch(/no workflow.*authority/is);
    expect(ORCHESTRATE_CAVEMAN_PROMPT_TEXT).toBe(CAVEMAN_PREAMBLE + ORCHESTRATE_PROMPT_TEXT);
  });
});
