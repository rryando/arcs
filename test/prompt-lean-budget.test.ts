import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const promptFiles = [
  "src/cli/arcs-flash.ts",
  "src/cli/arcs-orchestrate-caveman.ts",
  "src/cli/arcs-orchestrate.ts",
  "src/cli/orchestrator-shared-blocks.ts",
  "opencode/arcs/prompts/arcs-docs.txt",
  "opencode/arcs/prompts/code-reviewer.txt",
  "opencode/arcs/prompts/graph-explorer.txt",
  "opencode/arcs/prompts/software-engineer.txt",
  "opencode/arcs/prompts/tech-architect.txt",
  "opencode/arcs/skills/brainstorming/SKILL.md",
  "opencode/arcs/skills/brainstorming/visual-companion.md",
  "opencode/arcs/skills/caveman-commit/SKILL.md",
  "opencode/arcs/skills/deep-pr-review/SKILL.md",
  "opencode/arcs/skills/deep-pr-review/codegraph-diff.md",
  "opencode/arcs/skills/deep-pr-review/review-template.md",
  "opencode/arcs/skills/enriching-codegraph-proposals/SKILL.md",
  "opencode/arcs/skills/implementation/SKILL.md",
  "opencode/arcs/skills/init-project/SKILL.md",
  "opencode/arcs/skills/systematic-debugging/SKILL.md",
  "opencode/arcs/skills/systematic-debugging/condition-based-waiting.md",
  "opencode/arcs/skills/systematic-debugging/defense-in-depth.md",
  "opencode/arcs/skills/systematic-debugging/phases-reference.md",
  "opencode/arcs/skills/systematic-debugging/root-cause-tracing.md",
  "opencode/arcs/skills/test-driven-development/SKILL.md",
  "opencode/arcs/skills/test-driven-development/tdd-rationalizations-and-examples.md",
  "opencode/arcs/skills/test-driven-development/testing-anti-patterns.md",
  "opencode/arcs/skills/to-diagram/SKILL.md",
  "opencode/arcs/skills/writing-knowledge/SKILL.md",
  "opencode/arcs/skills/writing-plans/SKILL.md",
  "opencode/arcs/skills/writing-plans/plan-document-reviewer-prompt.md",
  "opencode/arcs/skills/writing-proposals/SKILL.md",
  "skills/explore-dag.md",
  "skills/init-project.md",
  "skills/orchestrate.md",
  "skills/update-docs.md",
] as const;

describe("canonical prompt source budget", () => {
  it("tracks the exact approved 35-file surface", () => {
    expect(promptFiles).toHaveLength(35);
    expect(new Set(promptFiles).size).toBe(promptFiles.length);
  });

  it("stays at least 50 percent below the 221746-byte baseline", () => {
    const bytes = promptFiles.reduce(
      (total, path) => total + Buffer.byteLength(readFileSync(resolve(root, path), "utf8"), "utf8"),
      0,
    );
    expect(bytes).toBeLessThanOrEqual(110_873);
  });
});
