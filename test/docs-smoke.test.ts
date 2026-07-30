import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ORCHESTRATE_PROMPT_TEXT } from "../src/cli/arcs-orchestrate.js";

// Resolve relative to project root (one level up from test/)
const root = resolve(import.meta.dirname, "..");

const readme = readFileSync(resolve(root, "README.md"), "utf-8");
const orchestrateSkill = readFileSync(resolve(root, "skills/orchestrate.md"), "utf-8");
const updateDocsSkill = readFileSync(resolve(root, "skills/update-docs.md"), "utf-8");
const initSkill = readFileSync(resolve(root, "skills/init-project.md"), "utf-8");
const exploreDagSkill = readFileSync(resolve(root, "skills/explore-dag.md"), "utf-8");
const orchestratePrompt = ORCHESTRATE_PROMPT_TEXT;
const rootCompatibilityDocs = [
  readme,
  orchestrateSkill,
  initSkill,
  exploreDagSkill,
  updateDocsSkill,
].join("\n");

describe("docs and skills smoke tests", () => {
  it("README mentions plan create command", () => {
    expect(readme).toContain("plans/*.md");
  });

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

  it("README mentions Queue / Plan / Memory", () => {
    expect(readme).toContain("Queue");
    expect(readme).toContain("Plan");
    expect(readme).toContain("Memory");
    expect(readme).toContain("tasks/index.json");
    expect(readme).toContain("plans/*.md");
    expect(readme).toContain("knowledge/*.md");
  });

  it("README mentions operating brief", () => {
    expect(readme).toContain("operating brief");
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

  it("README explains that OpenCode setup installs ARCS bundle", () => {
    expect(readme).toContain("~/.config/opencode/");
  });

  it("README explains the curated OpenCode runtime bundle", () => {
    expect(readme).toContain("build:opencode-bundle");
    expect(readme).toContain("lint-bundle");
  });

  it("documents the canonical six-agent and twelve-skill topology", () => {
    expect(readme).toMatch(/six typed sub-agents/i);
    for (const agent of [
      "software-engineer",
      "tech-architect",
      "graph-explorer",
      "code-reviewer",
      "devil-advocate",
      "arcs-docs",
    ]) {
      expect(readme).toContain(agent);
    }

    expect(readme).toMatch(/twelve skills/i);
    for (const skillName of [
      "implementation",
      "test-driven-development",
      "executing-plans",
      "systematic-debugging",
      "brainstorming",
      "writing-plans",
      "to-diagram",
      "writing-knowledge",
      "init-project",
      "enriching-codegraph-proposals",
      "deep-pr-review",
      "caveman-commit",
    ]) {
      expect(readme).toContain(skillName);
    }
  });

  it("keeps root compatibility docs on current agent modes and workflow", () => {
    expect(rootCompatibilityDocs).toMatch(/software-engineer[\s\S]*default[\s\S]*incident/i);
    expect(rootCompatibilityDocs).toMatch(/tech-architect[\s\S]*architecture[\s\S]*research/i);
    expect(rootCompatibilityDocs).toMatch(/code-reviewer[\s\S]*review[\s\S]*audit/i);
    expect(rootCompatibilityDocs).toMatch(/WORK_MODE[\s\S]*bounded[\s\S]*inspect/i);
    expect(rootCompatibilityDocs).toMatch(/brainstorming[\s\S]*user approv[\s\S]*writing-plans/i);
    expect(rootCompatibilityDocs).toMatch(/writing-plans[\s\S]*sole author/i);
    expect(rootCompatibilityDocs).toMatch(/SYNC[\s\S]*two-pass[\s\S]*audit[\s\S]*apply/i);
    expect(rootCompatibilityDocs).toMatch(
      /DAG-first[\s\S]*(?:codegraph|source|repository).*fallback/i,
    );
    expect(rootCompatibilityDocs).toMatch(/no automatic git actions/i);
  });

  it("removes superseded active agent and skill names from root compatibility docs", () => {
    expect(rootCompatibilityDocs).not.toMatch(
      /\b(?:oncall-ops|docs-researcher|quick-dev|code-agent|requesting-code-review|the-ladder)\b/,
    );
  });
});
