import { describe, expect, it } from "vitest";
import { FLASH_PROMPT_TEXT } from "../src/cli/arcs-flash.js";
import {
  AGENT_AND_SKILL_MATRIX_BLOCK,
  DIRECT_MUTATIONS_BLOCK,
  IDENTITY_AND_AUTHORITY_BLOCK,
  WORKFLOW_RULES_BLOCK,
} from "../src/cli/orchestrator-shared-blocks.js";

describe("flash prompt policy — lean direct mode", () => {
  it("is a thin speed-oriented variant of the direct lifecycle", () => {
    expect(FLASH_PROMPT_TEXT).toContain("arcs-flash");
    expect(FLASH_PROMPT_TEXT).toMatch(/minimal context/i);
    expect(FLASH_PROMPT_TEXT).toMatch(/UNDERSTAND\s*→\s*WORK\s*→\s*VERIFY\s*→\s*REPORT/);
    expect(FLASH_PROMPT_TEXT).toContain(IDENTITY_AND_AUTHORITY_BLOCK);
    expect(FLASH_PROMPT_TEXT).toContain(WORKFLOW_RULES_BLOCK);
    expect(FLASH_PROMPT_TEXT).toContain(DIRECT_MUTATIONS_BLOCK);
    expect(FLASH_PROMPT_TEXT).toContain(AGENT_AND_SKILL_MATRIX_BLOCK);
  });

  it("prefers owned delegation for separable work", () => {
    expect(FLASH_PROMPT_TEXT).toMatch(/strongly prefer delegation/is);
    expect(FLASH_PROMPT_TEXT).toMatch(/one owner per delegated outcome/i);
    expect(FLASH_PROMPT_TEXT).toMatch(/tiny.*tightly coupled.*orchestration-state/is);
    expect(FLASH_PROMPT_TEXT).toMatch(/no nested delegation/i);
  });

  it("searches knowledge exactly once for non-mechanical requests", () => {
    expect(FLASH_PROMPT_TEXT).toMatch(/exactly one targeted `arcs knowledge search`/i);
    expect(FLASH_PROMPT_TEXT.match(/arcs knowledge search/gi)).toHaveLength(1);
    expect(FLASH_PROMPT_TEXT).toMatch(/before non-mechanical work/i);
    expect(FLASH_PROMPT_TEXT).toMatch(/reuse.*across all.*dispatch/is);
    expect(FLASH_PROMPT_TEXT).toMatch(/skip.*mechanical work/i);
    expect(FLASH_PROMPT_TEXT).toMatch(/empty.*immediately.*repository evidence/is);
    expect(FLASH_PROMPT_TEXT).not.toMatch(
      /retry|KNOWLEDGE_CHECKED|knowledge ledger|knowledge gate|per-dispatch search/i,
    );
  });

  it("does not add tier or completion gates", () => {
    expect(FLASH_PROMPT_TEXT).not.toMatch(/Tier [0-3]|Every return is gated/);
    expect(FLASH_PROMPT_TEXT).not.toMatch(/completion gate.*never skipped/i);
    expect(FLASH_PROMPT_TEXT).not.toMatch(/only completion verifier/i);
  });

  it("keeps review optional and verification owned by the worker", () => {
    expect(FLASH_PROMPT_TEXT).toMatch(/agent that changes.*runs.*relevant verification/is);
    expect(FLASH_PROMPT_TEXT).toMatch(/review.*risk|risk.*review/is);
    expect(FLASH_PROMPT_TEXT).toMatch(/verification fails.*fix.*rerun/is);
  });
});
