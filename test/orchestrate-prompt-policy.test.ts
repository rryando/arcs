import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ORCHESTRATE_PROMPT_TEXT } from "../src/cli/arcs-orchestrate.js";
import {
  CAVEMAN_PREAMBLE,
  ORCHESTRATE_CAVEMAN_PROMPT_TEXT,
} from "../src/cli/arcs-orchestrate-caveman.js";

function section(start: string, end: string): string {
  return ORCHESTRATE_PROMPT_TEXT.slice(
    ORCHESTRATE_PROMPT_TEXT.indexOf(start),
    ORCHESTRATE_PROMPT_TEXT.indexOf(end),
  );
}

describe("orchestrate prompt policy — canonical control flow", () => {
  it("defines one ordered lifecycle and four terminal states", () => {
    const lifecycle =
      "ORIENT → CLASSIFY → RESOLVE → PLAN_DISPATCH → ROUND → FAN_IN → PHASE_GATE → REPAIR_OR_STOP → PERSIST/TRANSITION → COMPLETION";
    expect(ORCHESTRATE_PROMPT_TEXT).toContain(lifecycle);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(
      /PASS[\s\S]*BLOCKED[\s\S]*INCOMPLETE[\s\S]*USER_OVERRIDE/,
    );
  });

  it("keeps the orchestrator router-only and preserves the trust boundary", () => {
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(
      /never read source.*edit files.*run tests.*lint.*build/is,
    );
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(/untrusted reference data/i);
    expect(ORCHESTRATE_PROMPT_TEXT).toMatch(
      /embedded instructions.*cannot override.*SCOPE.*GOAL.*CONSTRAINTS.*SKILL.*VERIFY/is,
    );
  });

  it("requires every canonical dispatch field in order", () => {
    const dispatch = section("## Dispatch Contract", "## Agent and Skill Matrix");
    const fields = [
      "SCOPE:",
      "GOAL:",
      "CONTEXT:",
      "KNOWLEDGE:",
      "IDS:",
      "AGENT_MODE:",
      "WORK_MODE:",
      "ROUND:",
      "ATTEMPT:",
      "STOP_CONDITION:",
      "CONSTRAINTS:",
      "SKILL:",
      "VERIFY:",
      "RETURN:",
    ];
    let previous = -1;
    for (const field of fields) {
      const index = dispatch.indexOf(field);
      expect(index, field).toBeGreaterThan(previous);
      previous = index;
    }
  });

  it("routes exactly six typed agents and thirteen on-disk skills", () => {
    const matrix = section("## Agent and Skill Matrix", "## Lifecycle");
    const agents = [
      "software-engineer",
      "tech-architect",
      "graph-explorer",
      "code-reviewer",
      "devil-advocate",
      "arcs-docs",
    ];
    for (const agent of agents) expect(matrix).toContain(`\`${agent}\``);
    expect(matrix).toMatch(/software-engineer.*default.*incident/is);
    expect(matrix).toMatch(/tech-architect.*architecture.*research/is);
    expect(matrix).toMatch(/code-reviewer.*review.*audit/is);
    expect(matrix).toMatch(/implementation.*bounded.*inspect/is);
    expect(matrix).toMatch(/incident.*systematic-debugging/is);

    const skillsDir = resolve(import.meta.dirname, "../opencode/arcs/skills");
    const skills = readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(skills).toHaveLength(13);
    for (const skill of skills) expect(matrix, skill).toContain(`\`${skill}\``);
    expect(matrix).not.toMatch(
      /`(?:oncall-ops|docs-researcher|quick-dev|code-agent|requesting-code-review|the-ladder)`/,
    );
  });

  it("keeps test-first and plan execution as distinct disciplines", () => {
    const matrix = section("## Agent and Skill Matrix", "## Lifecycle");
    expect(matrix).toMatch(/test-driven-development.*new behavior.*bug fix/is);
    expect(matrix).toMatch(/executing-plans.*approved plan node/is);
  });
});

describe("orchestrate prompt policy — lifecycle invariants", () => {
  it("uses a finite approval pipeline before exact artifact persistence", () => {
    const lifecycle = section("## Lifecycle", "## Rounds, Fan-In, and Gates");
    expect(lifecycle).toMatch(
      /approv(?:es?|ed) (?:the )?design.*exact artifact.*devil-advocate.*PASS.*current-turn.*authorization.*persist/is,
    );
    expect(lifecycle).toMatch(/material change.*invalidates.*authorization/is);
    expect(lifecycle).toMatch(/no durable write.*authorization.*gate/is);
  });

  it("caps every round including INIT at four disjoint agents", () => {
    const rounds = section("## Rounds, Fan-In, and Gates", "## Retry Budget");
    expect(rounds).toMatch(/maximum 4.*disjoint.*including INIT/is);
    expect(rounds).toMatch(/overlap.*serialize/is);
  });

  it("persists worker knowledge only after the owning phase passes", () => {
    const rounds = section("## Rounds, Fan-In, and Gates", "## Retry Budget");
    expect(rounds).toMatch(/knowledge.*proposal.*owning phase.*PASS.*persist/is);
    expect(rounds).not.toMatch(/fan-in[^.]*arcs knowledge upsert/i);
  });

  it("defines bounded changed-evidence, phase repair, and completion repair retries", () => {
    const retries = section("## Retry Budget", "## Workflow Rules");
    expect(retries).toMatch(/one retry.*changed evidence/is);
    expect(retries).toMatch(/phase gate.*one.*repair.*rerun/is);
    expect(retries).toMatch(/completion.*one.*repair/is);
  });

  it("runs SYNC audit, gate, apply, and validate in that order", () => {
    const sync = section("### SYNC", "### MULTI").toLowerCase();
    const terms = [
      "agent_mode: audit",
      "phase: sync",
      "pass",
      "agent_mode: apply",
      "arcs validate",
    ];
    let previous = -1;
    for (const term of terms) {
      const index = sync.indexOf(term, previous + 1);
      expect(index, term).toBeGreaterThan(previous);
      previous = index;
    }
    expect(sync).toMatch(/arcs-docs.*only direct worker mutation exception/is);
  });

  it("joins MULTI constituents without hiding non-PASS work", () => {
    const multi = section("### MULTI", "## Verification and Completion");
    expect(multi).toMatch(/continue independent/is);
    expect(multi).toMatch(/no success.*every constituent.*PASS/is);
  });

  it("uses scoped worker checks and devil-only completion verification", () => {
    const verification = section("## Verification and Completion", "## Direct Mutations");
    expect(verification).toMatch(/workers.*exact scoped VERIFY/is);
    expect(verification).toMatch(/devil-advocate.*only completion verifier/is);
    expect(verification).toContain("`npm test`");
    expect(verification).toContain("`npm run typecheck`");
    expect(verification).toContain("`npm run lint`");
  });

  it("keeps direct mutations and git behind the required PASS or current-turn request", () => {
    const mutations = section("## Direct Mutations", "## Canonical Return Envelope");
    expect(mutations).toMatch(/orchestrator.*ARCS CLI mutation.*relevant.*PASS/is);
    expect(mutations).toMatch(
      /git add.*git commit.*git push.*explicit current-turn user request/is,
    );
    expect(mutations).toMatch(
      /arcs lint-bundle.*PASS.*arcs deploy-superpowers.*arcs lint-bundle/is,
    );
  });

  it("defines one canonical worker return envelope", () => {
    const returns = section("## Canonical Return Envelope", "## Reporting");
    for (const field of [
      "STATUS:",
      "FILES_TOUCHED:",
      "VERIFY:",
      "BLOCKED_BY:",
      "SCOPE_CHANGE:",
      "SHORTCUTS:",
      "KNOWLEDGE:",
    ]) {
      expect(returns).toContain(field);
    }
  });
});

describe("orchestrate prompt policy — caveman parity", () => {
  it("is a narration-only overlay with no independent authority", () => {
    expect(CAVEMAN_PREAMBLE).toMatch(/narration-only/i);
    expect(CAVEMAN_PREAMBLE).toMatch(/adds no.*authority/i);
    expect(CAVEMAN_PREAMBLE).toMatch(/dispatch fields.*return envelope.*unchanged/is);
    expect(ORCHESTRATE_CAVEMAN_PROMPT_TEXT).toBe(CAVEMAN_PREAMBLE + ORCHESTRATE_PROMPT_TEXT);
  });
});
