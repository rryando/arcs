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
    expect(FLASH_PROMPT_TEXT).toMatch(
      /PARSE\s*→\s*DISPATCH\s*→\s*COLLECT\s*→\s*SYNTHESIZE\s*→\s*REPORT/,
    );
    expect(FLASH_PROMPT_TEXT).toContain(IDENTITY_AND_AUTHORITY_BLOCK);
    expect(FLASH_PROMPT_TEXT).toContain(WORKFLOW_RULES_BLOCK);
    expect(FLASH_PROMPT_TEXT).toContain(DIRECT_MUTATIONS_BLOCK);
    expect(FLASH_PROMPT_TEXT).toContain(AGENT_AND_SKILL_MATRIX_BLOCK);
  });

  it("delegates aggressively via routing tiers", () => {
    expect(FLASH_PROMPT_TEXT).toMatch(/bounded discovery/i);
    expect(FLASH_PROMPT_TEXT).toMatch(/Implement.*Fix.*software-engineer/is);
    expect(FLASH_PROMPT_TEXT).toMatch(/Explore.*Discover.*graph-explorer/is);
    expect(FLASH_PROMPT_TEXT).toMatch(/one owner per outcome/i);
    expect(FLASH_PROMPT_TEXT).toMatch(/tiny code tasks.*one.*software-engineer/is);
    expect(FLASH_PROMPT_TEXT).toMatch(/no nested delegation/i);
  });

  it("uses optional compact knowledge without a source-reading fallback", () => {
    expect(FLASH_PROMPT_TEXT).toMatch(/knowledge search.*only when useful/i);
    expect(FLASH_PROMPT_TEXT).toMatch(/empty.*delegate.*repository evidence/is);
    expect(FLASH_PROMPT_TEXT).not.toMatch(
      /exactly one targeted|before dispatching non-mechanical|keep small cohesive work local/i,
    );
  });

  it("dispatches all separable units in parallel on first action", () => {
    expect(FLASH_PROMPT_TEXT).toMatch(/independent.*parallel/is);
    expect(FLASH_PROMPT_TEXT).not.toMatch(/Tier [0-3]|Every return is gated/);
    expect(FLASH_PROMPT_TEXT).not.toMatch(/completion gate.*never skipped/i);
    expect(FLASH_PROMPT_TEXT).not.toMatch(/only completion verifier/i);
  });
});
