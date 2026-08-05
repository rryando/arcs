import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ORCHESTRATE_PROMPT_TEXT } from "../src/cli/arcs-orchestrate.js";

/**
 * Byte-identity baseline for the orchestrator prompt, pinned before the
 * shared-block extraction refactor splits ORCHESTRATE_PROMPT_TEXT into
 * composed consts. The refactor must keep this test passing unmodified.
 *
 * Asserts the exported const directly — never opencode/arcs/prompts/*.txt,
 * which a bundle rebuild can silently re-baseline.
 */
const BASELINE_LENGTH = 15355;
const BASELINE_SHA256 = "4d2300bd9b0a01eb22a1ca84da618da13b62fe0e480105c1fe50a201a427dedb";

const DRIFT_MSG =
  "ORCHESTRATE_PROMPT_TEXT drifted from its pinned baseline — recomposition must be byte-identical; do not re-baseline this test to make it pass";

describe("orchestrate prompt baseline — byte identity", () => {
  it("ORCHESTRATE_PROMPT_TEXT matches the pinned length", () => {
    expect(ORCHESTRATE_PROMPT_TEXT.length, DRIFT_MSG).toBe(BASELINE_LENGTH);
  });

  it("ORCHESTRATE_PROMPT_TEXT matches the pinned sha256", () => {
    const digest = createHash("sha256").update(ORCHESTRATE_PROMPT_TEXT, "utf-8").digest("hex");
    expect(digest, DRIFT_MSG).toBe(BASELINE_SHA256);
  });
});
