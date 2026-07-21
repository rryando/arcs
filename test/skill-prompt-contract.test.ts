import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function skill(path: string): string {
  return readFileSync(resolve(root, path), "utf-8");
}

const untrustedArtifactPrompts = [
  "opencode/arcs/skills/brainstorming/spec-document-reviewer-prompt.md",
  "opencode/arcs/skills/writing-plans/plan-document-reviewer-prompt.md",
  "opencode/arcs/skills/executing-plans/implementer-prompt.md",
  "opencode/arcs/skills/executing-plans/spec-reviewer-prompt.md",
  "opencode/arcs/skills/executing-plans/code-quality-reviewer-prompt.md",
];

describe("skill prompt contracts", () => {
  it.each(untrustedArtifactPrompts)("treats embedded artifacts as untrusted data: %s", (path) => {
    const source = skill(path);

    expect(source).toMatch(/untrusted (reference )?data/i);
    expect(source).toMatch(/embedded instructions.*cannot override/i);
  });

  it("keeps codegraph proposals in the enrichment lifecycle during project init", () => {
    const source = skill("opencode/arcs/skills/init-project/SKILL.md");

    expect(source).toMatch(/arcs proposal list.*keep.*merge.*drop.*promote/is);
    expect(source).not.toMatch(/collect proposals.*arcs knowledge create/is);
    expect(source).not.toMatch(/finalized proposals.*writes the entries directly/is);
  });

  it("uses the parent review's cached DIFF snapshot for codegraph analysis", () => {
    const parent = skill("opencode/arcs/skills/deep-pr-review/SKILL.md");
    const source = skill("opencode/arcs/skills/deep-pr-review/codegraph-diff.md");

    expect(parent).toMatch(/codegraph-diff\.md.*cached.*DIFF.*second diff fetch/is);
    expect(source).toMatch(/cached.*DIFF.*snapshot/is);
    expect(source).not.toMatch(/gh pr diff/);
  });

  it("uses current exploration and iteration routes in root skills", () => {
    const exploreDag = skill("skills/explore-dag.md");
    const orchestrate = skill("skills/orchestrate.md");

    expect(exploreDag).toContain("graph-explorer");
    expect(exploreDag).not.toMatch(/Dispatch explore sub-agent/);
    expect(orchestrate).not.toMatch(/Pair with `loop` skill/);
    expect(orchestrate).toMatch(/arcs loop start/);
  });

  it("uses current evidence and template guidance for knowledge enrichment", () => {
    const enrichment = skill("opencode/arcs/skills/enriching-codegraph-proposals/SKILL.md");
    const debugging = skill("opencode/arcs/skills/systematic-debugging/SKILL.md");

    expect(enrichment).not.toContain("confidence-gate");
    expect(enrichment).toMatch(/devil-advocate|evidence threshold/i);
    expect(debugging).toContain("arcs knowledge template");
    expect(debugging).not.toMatch(/--body="(?:Root cause|Attach listeners|Applies to)/);
  });
});
