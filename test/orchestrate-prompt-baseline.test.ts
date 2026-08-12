import { describe, expect, it } from "vitest";
import { FLASH_PROMPT_TEXT } from "../src/cli/arcs-flash.js";
import { ORCHESTRATE_PROMPT_TEXT } from "../src/cli/arcs-orchestrate.js";
import {
  CAVEMAN_PREAMBLE,
  ORCHESTRATE_CAVEMAN_PROMPT_TEXT,
} from "../src/cli/arcs-orchestrate-caveman.js";

describe("orchestrator prompt lean budget", () => {
  it("bounds each primary prompt without pinning exact prose", () => {
    expect(ORCHESTRATE_PROMPT_TEXT.length).toBeLessThanOrEqual(7000);
    expect(FLASH_PROMPT_TEXT.length).toBeLessThanOrEqual(7500);
    expect(ORCHESTRATE_CAVEMAN_PROMPT_TEXT.length).toBeLessThanOrEqual(8000);
  });

  it("keeps caveman as a small exact overlay", () => {
    expect(CAVEMAN_PREAMBLE.length).toBeLessThanOrEqual(800);
    expect(ORCHESTRATE_CAVEMAN_PROMPT_TEXT).toBe(CAVEMAN_PREAMBLE + ORCHESTRATE_PROMPT_TEXT);
  });
});
