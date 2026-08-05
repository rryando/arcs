import { describe, expect, it } from "vitest";
import { FLASH_PROMPT_TEXT } from "../src/cli/arcs-flash.js";
import {
  AGENT_AND_SKILL_MATRIX_BLOCK,
  CANONICAL_RETURN_ENVELOPE_BLOCK,
  DIRECT_MUTATIONS_BLOCK,
  DISPATCH_CONTRACT_BLOCK,
  FINITE_HITL_DESIGN_PIPELINE_BLOCK,
  IDENTITY_AND_AUTHORITY_BLOCK,
  REPORTING_BLOCK,
  TERMINAL_STATES_BLOCK,
  WORKFLOW_RULES_BLOCK,
} from "../src/cli/orchestrator-shared-blocks.js";

function section(start: string, end: string): string {
  return FLASH_PROMPT_TEXT.slice(FLASH_PROMPT_TEXT.indexOf(start), FLASH_PROMPT_TEXT.indexOf(end));
}

describe("flash prompt policy — identity and composition", () => {
  it("opens as the speed-optimized, knowledge-first, parallel-first orchestrator", () => {
    const opening = FLASH_PROMPT_TEXT.slice(
      0,
      FLASH_PROMPT_TEXT.indexOf("## Identity and Authority"),
    );
    expect(opening).toContain("arcs-flash");
    expect(opening).toContain("speed-optimized ARCS orchestrator");
    expect(opening).toMatch(/knowledge-first orientation.*parallel-first rounds/is);
    expect(opening).toMatch(/cheaper, never weaker/i);
    expect(opening).toMatch(/never evidence/i);
  });

  it("reuses every shared orchestrator block verbatim", () => {
    const blocks = [
      IDENTITY_AND_AUTHORITY_BLOCK,
      TERMINAL_STATES_BLOCK,
      DISPATCH_CONTRACT_BLOCK,
      AGENT_AND_SKILL_MATRIX_BLOCK,
      FINITE_HITL_DESIGN_PIPELINE_BLOCK,
      WORKFLOW_RULES_BLOCK,
      DIRECT_MUTATIONS_BLOCK,
      CANONICAL_RETURN_ENVELOPE_BLOCK,
      REPORTING_BLOCK,
    ];
    for (const block of blocks) expect(FLASH_PROMPT_TEXT.includes(block)).toBe(true);
    expect(FLASH_PROMPT_TEXT).toContain(
      `${IDENTITY_AND_AUTHORITY_BLOCK}\n\n${TERMINAL_STATES_BLOCK}`,
    );
    expect(FLASH_PROMPT_TEXT.endsWith(REPORTING_BLOCK)).toBe(true);
  });

  it("treats FILES_TOUCHED as a return value, not a dispatch input", () => {
    const dispatch = section("## Dispatch Contract", "## Agent and Skill Matrix");
    expect(dispatch).toContain("FILES_TOUCHED is a RETURN value, not a dispatch input");
    expect(dispatch).toMatch(
      /SCOPE names the deliverable.*hands-off boundary.*test-discoverable/is,
    );
    expect(dispatch).toMatch(/workers report the exact files back/i);
  });
});

describe("flash prompt policy — knowledge-first lifecycle", () => {
  const lifecycle = section("## Lifecycle", "### Finite HITL Design Pipeline");

  it("orients on knowledge before any repository dispatch", () => {
    expect(lifecycle).toMatch(/arcs brief --lean --json` once.*arcs knowledge search/is);
    expect(lifecycle).toContain("BEFORE any repository dispatch");
    expect(lifecycle).toContain("KNOWLEDGE_CHECKED: <search cmd + result count>");
    expect(lifecycle).toMatch(/KNOWLEDGE_CHECKED.*before PLAN_DISPATCH/is);
    expect(lifecycle).toMatch(/non-mechanical constituents/i);
  });

  it("bounds thin results to one broadened retry and gates decisive writes on anchors", () => {
    expect(lifecycle).toMatch(
      /Thin or empty results.*one broadened-keyword retry.*fall through to repository facts/is,
    );
    expect(lifecycle).toMatch(
      /decisive for a WRITE decision only after.*source-file anchors are confirmed current/is,
    );
    expect(lifecycle).toMatch(/read-only use needs no confirmation/i);
  });

  it("keeps read-only fan-out unbounded and user questions batched into one round", () => {
    expect(lifecycle).toContain("Read-only fan-out is unbounded");
    expect(lifecycle).toMatch(/Batch user questions into one round/i);
  });

  it("restricts speculative fan-out to fact-convergent read-only branches", () => {
    expect(lifecycle).toContain("read-only branches ONLY");
    expect(lifecycle).toContain("2-3 disjoint hypotheses converging on one verifiable fact");
    expect(lifecycle).toMatch(/Never fan out judgment questions.*result-shopping/is);
  });

  it("ledgers speculative branches with exactly three tri-state values", () => {
    const states = ["`speculative`", "`selected`", "`discarded`"];
    let previous = -1;
    for (const state of states) {
      const index = lifecycle.indexOf(state);
      expect(index, state).toBeGreaterThan(previous);
      previous = index;
    }
    expect(lifecycle).toMatch(/evidence bundles.*structurally exclude discarded/is);
  });
});

describe("flash prompt policy — tiered gate model", () => {
  const rounds = section("## Rounds, Fan-In, and Gates", "## Retry Budget");

  it("names four gate tiers in ascending order", () => {
    const tiers = ["Tier 0", "Tier 1", "Tier 2", "Tier 3"];
    let previous = -1;
    for (const tier of tiers) {
      const index = rounds.indexOf(tier);
      expect(index, tier).toBeGreaterThan(previous);
      previous = index;
    }
    expect(rounds).toMatch(/Tier 0 — no gate.*read-only constituent.*zero durable mutation/is);
    expect(rounds).toMatch(/evidence is recorded only/i);
  });

  it("keeps Tier 1 a mechanical checklist behind six ordered predicates", () => {
    expect(rounds).toContain("mechanical checklist, no dispatch");
    expect(rounds).toContain("NEVER a correctness judgment");
    expect(rounds).toContain("Eligible only while ALL six hold");
    const predicates = [
      "`FILES_TOUCHED==1`",
      "`SCOPE_CHANGE==none`",
      "`VERIFY==pass`",
      "`KNOWLEDGE==none`",
      "`SHORTCUTS==none`",
      "the touched path is not a dependency, schema, or contract file and is not shared with another in-flight scope",
    ];
    let previous = -1;
    for (const predicate of predicates) {
      const index = rounds.indexOf(predicate);
      expect(index, predicate).toBeGreaterThan(previous);
      previous = index;
    }
    expect(rounds).toContain("(never `none`)");
    expect(rounds).toContain("`BLOCKED_BY!=none` is never gate-eligible");
  });

  it("keeps read-only width unbounded at Tier 0 and caps mixed gate batches at four", () => {
    expect(rounds).toContain("Read-only round width is UNBOUNDED at Tier 0");
    expect(rounds).toMatch(
      /Tier 2.*multi-file, cross-module, new dependency, durable ARCS write, or git action/is,
    );
    expect(rounds).toContain(
      "The moment any return crosses into Tier 2, gate-batch group size caps at 4",
    );
  });

  it("keeps Tier 3 unconditional and never inherited from Tier-1 passes", () => {
    expect(rounds).toMatch(/Tier 3 — completion.*Unconditional when files changed/is);
    expect(rounds).toContain("never inherited from Tier-1 passes");
    expect(rounds).toContain("re-evaluated per constituent");
  });

  it("runs one gate per round and keeps it off the critical path without keeping purged work", () => {
    expect(rounds).toMatch(/One gate per round.*FAN_IN scope-overlap detection first/is);
    expect(rounds).toContain("tagged `PROVISIONAL`");
    expect(rounds).toMatch(/READ-ONLY work may launch concurrently/i);
    expect(rounds).toMatch(/causally downstream.*PURGED, not ignored/is);
    expect(rounds).toContain("Evidence pre-packaging is a hard MUST");
    expect(rounds).toMatch(/gate never re-derives context/i);
  });

  it("scopes the plan-time gate to the request, not the code surface", () => {
    const verification = section("## Verification and Completion", "## Direct Mutations");
    expect(rounds).toMatch(
      /plan-time gate evaluates the request.*goal.*design coherence.*authorization.*bounded scope.*verification no existing test provides/is,
    );
    expect(rounds).toContain("prohibited from blocking on code-surface completeness");
    expect(rounds).toMatch(/Test-discoverable findings flow to the executor as advisories/i);
    // Paired: the A2 relaxation is plan-time only and never reaches completion verification.
    expect(verification).toContain("only completion verifier");
    expect(verification).not.toContain("prohibited from blocking on code-surface completeness");
  });
});

describe("flash prompt policy — retry budget and completion", () => {
  const retries = section("## Retry Budget", "## Workflow Rules");

  it("keeps the bounded changed-evidence retry", () => {
    expect(retries).toMatch(/one retry only.*changed evidence.*ATTEMPT: evidence-retry/is);
    expect(retries).toMatch(/never the same packet replayed/i);
    expect(retries).toMatch(/INCOMPLETE or BLOCKED/);
  });

  it("scopes zero repair to the plan-time gate while preserving completion repair", () => {
    const zeroPlanTimeRepair = retries.indexOf("zero repair rounds at the plan-time gate");
    const completionPreserved = retries.indexOf("the completion-repair budget is preserved");
    expect(zeroPlanTimeRepair).toBeGreaterThan(-1);
    expect(completionPreserved).toBeGreaterThan(zeroPlanTimeRepair);
    expect(retries).toMatch(/advisories flow to the executor/i);
    expect(retries).toContain("Zero-plan-time-repair is scoped to that gate, never global");
    expect(retries).toMatch(/one owning-scope repair.*ATTEMPT: repair/is);
    expect(retries).toMatch(/ATTEMPT: completion-repair/);
  });

  it("uses scoped worker checks and a single completion verifier", () => {
    const verification = section("## Verification and Completion", "## Direct Mutations");
    expect(verification).toMatch(/Workers run the exact scoped VERIFY/i);
    expect(verification).toMatch(/no full suite, project-wide lint, or full build/i);
    expect(verification).toContain("only completion verifier");
    expect(verification).toContain("`npm test`");
    expect(verification).toContain("`npm run typecheck`");
    expect(verification).toContain("`npm run lint`");
    expect(verification).toMatch(/When files changed.*completion gate runs once.*never skipped/is);
  });
});

describe("flash prompt policy — size budget", () => {
  it("stays inside the flash character ceiling", () => {
    // Character growth ceiling for a new file, deliberately NOT the
    // tokenizer-dependent token-budget approach this repo previously rejected.
    expect(FLASH_PROMPT_TEXT.length).toBeLessThanOrEqual(16000);
  });
});
