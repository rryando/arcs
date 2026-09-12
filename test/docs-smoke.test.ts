import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ORCHESTRATE_PROMPT_TEXT } from "../src/cli/arcs-orchestrate.js";

// Resolve relative to project root (one level up from test/)
const root = resolve(import.meta.dirname, "..");

const orchestrateSkill = readFileSync(resolve(root, "skills/orchestrate.md"), "utf-8");
const updateDocsSkill = readFileSync(resolve(root, "skills/update-docs.md"), "utf-8");
const initSkill = readFileSync(resolve(root, "skills/init-project.md"), "utf-8");
const exploreDagSkill = readFileSync(resolve(root, "skills/explore-dag.md"), "utf-8");
const orchestratePrompt = ORCHESTRATE_PROMPT_TEXT;
const skillCompatibilityDocs = [orchestrateSkill, initSkill, exploreDagSkill, updateDocsSkill].join(
  "\n",
);

describe("docs and skills smoke tests", () => {
  it("keeps root skill frontmatter and direct guidance", () => {
    for (const source of [orchestrateSkill, initSkill, exploreDagSkill, updateDocsSkill]) {
      expect(source).toMatch(/^---\nname: /);
      expect(source).toMatch(/description:/);
    }
  });

  it("keeps orchestration source-free", () => {
    expect(orchestrateSkill).toMatch(/PARSE.*DISPATCH.*COLLECT.*SYNTHESIZE.*REPORT/is);
    expect(orchestrateSkill).toMatch(/zero implementation-source reads/is);
    expect(orchestrateSkill).toMatch(/tiny code tasks get one engineer/is);
    expect(orchestrateSkill).toMatch(/orchestration bookkeeping/is);
    expect(orchestrateSkill).toMatch(/one outcome owner.*no nested delegation/is);
    expect(orchestrateSkill).toMatch(/material risk or contradictions.*independent reviewer/is);
  });

  it("keeps initialization authorized and codegraph optional", () => {
    expect(initSkill).toMatch(/explicit request.*authorizes/is);
    expect(initSkill).toMatch(/codegraph.*optional/is);
    expect(initSkill).not.toMatch(/devil-advocate|exact authorization/i);
  });

  it("keeps exploration bounded and graph-explorer optional", () => {
    expect(exploreDagSkill).toMatch(/narrowest useful command/i);
    expect(exploreDagSkill).toMatch(/optional.*graph-explorer/is);
    expect(exploreDagSkill).toMatch(/avoid broad scans/i);
  });

  it("keeps documentation updates scoped and validated", () => {
    expect(updateDocsSkill).toMatch(/requested scoped update.*validate/is);
    expect(updateDocsSkill).toMatch(/knowledge.*body.*source files/is);
    expect(updateDocsSkill).toMatch(/diagrams.*task metadata/is);
  });

  it("keeps the canonical prompt aligned with root guidance", () => {
    expect(orchestratePrompt).toMatch(/PARSE.*DISPATCH.*COLLECT.*SYNTHESIZE.*REPORT/is);
    expect(orchestratePrompt).toMatch(/zero implementation-source reads/is);
    expect(orchestratePrompt).toMatch(/tiny code tasks.*software-engineer/is);
    expect(orchestratePrompt).not.toMatch(/only completion verifier|PHASE_GATE|exact artifact/i);
  });

  it("removes superseded active agent and skill names from skill docs", () => {
    expect(skillCompatibilityDocs).not.toMatch(
      /\b(?:oncall-ops|docs-researcher|quick-dev|code-agent|requesting-code-review|the-ladder)\b/,
    );
  });
});
