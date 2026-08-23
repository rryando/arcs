import { describe, expect, it } from "vitest";
import { FLASH_PROMPT_TEXT } from "../src/cli/arcs-flash.js";
import {
  AGENT_AND_SKILL_MATRIX_BLOCK,
  DIRECT_MUTATIONS_BLOCK,
  IDENTITY_AND_AUTHORITY_BLOCK,
  WORKFLOW_RULES_BLOCK,
} from "../src/cli/orchestrator-shared-blocks.js";

describe("flash prompt policy — dispatch-first with flash bias", () => {
  it("is a thin speed-oriented orchestrator variant", () => {
    expect(FLASH_PROMPT_TEXT).toContain("arcs-flash");
    expect(FLASH_PROMPT_TEXT).toMatch(/minimal-context/i);
    expect(FLASH_PROMPT_TEXT).toMatch(/PARSE\s*→\s*DISPATCH\s*→\s*COLLECT\s*→\s*SYNTHESIZE\s*→\s*REPORT/);
    expect(FLASH_PROMPT_TEXT).toContain(IDENTITY_AND_AUTHORITY_BLOCK);
    expect(FLASH_PROMPT_TEXT).toContain(WORKFLOW_RULES_BLOCK);
    expect(FLASH_PROMPT_TEXT).toContain(DIRECT_MUTATIONS_BLOCK);
    expect(FLASH_PROMPT_TEXT).toContain(AGENT_AND_SKILL_MATRIX_BLOCK);
  });

  it("delegates aggressively via routing tiers", () => {
    expect(FLASH_PROMPT_TEXT).toMatch(/delegate aggressively/i);
    expect(FLASH_PROMPT_TEXT).toMatch(/Implement.*Fix.*software-engineer/is);
    expect(FLASH_PROMPT_TEXT).toMatch(/Explore.*Investigate.*graph-explorer/is);
    expect(FLASH_PROMPT_TEXT).toMatch(/one owner per outcome/i);
    expect(FLASH_PROMPT_TEXT).toMatch(/tiny tightly coupled/i);
    expect(FLASH_PROMPT_TEXT).toMatch(/no nested delegation/i);
  });

  it("searches knowledge exactly once for non-mechanical requests", () => {
    expect(FLASH_PROMPT_TEXT).toMatch(/exactly one targeted `arcs knowledge search`/i);
    expect(FLASH_PROMPT_TEXT.match(/arcs knowledge search/gi)).toHaveLength(1);
    expect(FLASH_PROMPT_TEXT).toMatch(/before dispatching non-mechanical/i);
    expect(FLASH_PROMPT_TEXT).toMatch(/skip.*mechanical work/i);
    expect(FLASH_PROMPT_TEXT).toMatch(/empty.*(?:immediately )?.*repository evidence/is);
    expect(FLASH_PROMPT_TEXT).not.toMatch(
      /retry|KNOWLEDGE_CHECKED|knowledge ledger|knowledge gate|per-dispatch search/i,
    );
  });

  it("dispatches all separable units in parallel on first action", () => {
    expect(FLASH_PROMPT_TEXT).toMatch(/parallel.*first action|first action.*parallel/is);
    expect(FLASH_PROMPT_TEXT).not.toMatch(/Tier [0-3]|Every return is gated/);
    expect(FLASH_PROMPT_TEXT).not.toMatch(/completion gate.*never skipped/i);
    expect(FLASH_PROMPT_TEXT).not.toMatch(/only completion verifier/i);
  });
});