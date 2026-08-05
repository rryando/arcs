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
  it("update-docs skill mentions knowledge entries", () => {
    expect(updateDocsSkill).toContain("knowledge entries");
  });

  it("orchestrate skill mentions MULTI", () => {
    expect(orchestrateSkill).toContain("MULTI");
  });

  it("init skill mentions plans/", () => {
    expect(initSkill).toContain("plans/");
  });

  it("init skill mentions knowledge/", () => {
    expect(initSkill).toContain("knowledge/");
  });

  it("explore-dag skill mentions plan and knowledge indexes", () => {
    expect(exploreDagSkill).toContain("plan and knowledge indexes");
  });

  it("update-docs skill mentions structured plans for feature work", () => {
    expect(updateDocsSkill).toContain("structured plans for feature work");
  });

  it("update-docs skill mentions knowledge.md", () => {
    expect(updateDocsSkill).toContain("knowledge.md");
  });

  it("orchestrate prompt mentions queue / plan / memory", () => {
    expect(orchestratePrompt).toContain("queue / plan / memory");
    expect(orchestratePrompt).toContain("**queue** = immediate execution state in `tasks.md`");
    expect(orchestratePrompt).toContain("**plan** = durable multi-step change record");
    expect(orchestratePrompt).toContain("**memory** = durable reusable knowledge");
  });

  it("orchestrate prompt mentions recommended surface", () => {
    expect(orchestratePrompt).toContain("recommended surface");
  });

  it("orchestrate prompt mentions operating brief", () => {
    expect(orchestratePrompt).toContain("operating brief");
    expect(orchestratePrompt).toContain("queue / plan / memory");
  });

  it("orchestrate prompt mentions three-surface model", () => {
    expect(orchestratePrompt).toContain("queue");
    expect(orchestratePrompt).toContain("plan");
    expect(orchestratePrompt).toContain("memory");
  });

  it("keeps skill docs on current agent modes and workflow", () => {
    expect(skillCompatibilityDocs).toMatch(/software-engineer[\s\S]*default[\s\S]*incident/i);
    expect(skillCompatibilityDocs).toMatch(/tech-architect[\s\S]*architecture[\s\S]*research/i);
    expect(skillCompatibilityDocs).toMatch(/code-reviewer[\s\S]*review[\s\S]*audit/i);
    expect(skillCompatibilityDocs).toMatch(/WORK_MODE[\s\S]*bounded[\s\S]*inspect/i);
    expect(skillCompatibilityDocs).toMatch(/brainstorming[\s\S]*user approv[\s\S]*writing-plans/i);
    expect(skillCompatibilityDocs).toMatch(/writing-plans[\s\S]*sole author/i);
    expect(skillCompatibilityDocs).toMatch(/SYNC[\s\S]*two-pass[\s\S]*audit[\s\S]*apply/i);
    expect(skillCompatibilityDocs).toMatch(
      /DAG-first[\s\S]*(?:codegraph|source|repository).*fallback/i,
    );
    expect(skillCompatibilityDocs).toMatch(/no automatic git actions/i);
  });

  it("removes superseded active agent and skill names from skill docs", () => {
    expect(skillCompatibilityDocs).not.toMatch(
      /\b(?:oncall-ops|docs-researcher|quick-dev|code-agent|requesting-code-review|the-ladder)\b/,
    );
  });
});
