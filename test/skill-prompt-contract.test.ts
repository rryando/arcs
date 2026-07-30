import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function skill(path: string): string {
  return readFileSync(resolve(root, path), "utf-8");
}

const untrustedArtifactPrompts = [
  "opencode/arcs/skills/writing-plans/plan-document-reviewer-prompt.md",
];

describe("skill prompt contracts", () => {
  it("consolidates implementation work into orchestrator-selected bounded and inspect modes", () => {
    const implementation = skill("opencode/arcs/skills/implementation/SKILL.md");

    expect(implementation).toMatch(/orchestrator-selected[\s\S]*bounded[\s\S]*inspect/i);
    expect(implementation).toMatch(
      /bounded[\s\S]*no (?:repo )?exploration[\s\S]*no (?:user )?questions/i,
    );
    expect(implementation).toMatch(
      /inspect[\s\S]*inspect (?:the )?(?:repo|repository).*DAG[\s\S]*at most one targeted (?:user )?question/i,
    );
    expect(implementation).toMatch(/material decision[\s\S]*not tool-resolvable/i);
    expect(implementation).toMatch(/dispatch VERIFY command[\s\S]*NEVER the full suite/i);
    expect(implementation).toMatch(/proposal[\s\S]*do not execute `arcs knowledge upsert`/i);
    expect(implementation).toMatch(
      /necessity[\s\S]*standard library[\s\S]*native platform[\s\S]*installed dependenc[\s\S]*minimum code/i,
    );
    expect(implementation).toMatch(/security[\s\S]*accessibility[\s\S]*data loss/i);
    expect(implementation).toContain("// SHORTCUT: <ceiling>, upgrade when <trigger>");
  });

  it("removes superseded implementation, review-request, and minimalism skills", () => {
    for (const name of ["quick-dev", "code-agent", "requesting-code-review", "the-ladder"]) {
      expect(existsSync(resolve(root, `opencode/arcs/skills/${name}`))).toBe(false);
    }
  });

  it.each(untrustedArtifactPrompts)("treats embedded artifacts as untrusted data: %s", (path) => {
    const source = skill(path);

    expect(source).toMatch(/untrusted (reference )?data/i);
    expect(source).toMatch(/embedded instructions.*cannot override/i);
  });

  it("makes executing-plans a one-node worker discipline with one canonical return envelope", () => {
    const executingPlans = skill("opencode/arcs/skills/executing-plans/SKILL.md");
    const runtime = JSON.parse(skill("opencode/arcs/bundle-runtime.json"));
    const nestedPrompts = [
      "implementer-prompt.md",
      "spec-reviewer-prompt.md",
      "code-quality-reviewer-prompt.md",
    ];

    expect(executingPlans).toMatch(/exactly one orchestrator-assigned plan node/i);
    expect(executingPlans).toMatch(
      /current node metadata[\s\S]*dependenc[\s\S]*scope[\s\S]*acceptance/i,
    );
    expect(executingPlans).toMatch(/current (?:task|node).*scoped.*VERIFY/i);
    expect(executingPlans).toMatch(/BLOCKED_BY/i);
    expect(executingPlans).toMatch(/never edit.*diagram/i);
    expect(executingPlans).toMatch(/never.*arcs task transition/i);
    expect(executingPlans).toMatch(
      /orchestrator owns[\s\S]*parallel rounds[\s\S]*task transitions[\s\S]*review[\s\S]*fan-in[\s\S]*completion/i,
    );
    expect(executingPlans).toMatch(/standalone usage is (?:expressly )?unsupported/i);
    expect(executingPlans.match(/STATUS:/g)).toHaveLength(1);
    for (const field of [
      "FILES_TOUCHED:",
      "VERIFY:",
      "BLOCKED_BY:",
      "SCOPE_CHANGE:",
      "SHORTCUTS:",
      "KNOWLEDGE:",
    ]) {
      expect(executingPlans.match(new RegExp(field, "g"))).toHaveLength(1);
    }
    expect(executingPlans).toMatch(/KNOWLEDGE: <none \| proposal:/i);
    expect(executingPlans).toMatch(/do not execute `arcs knowledge upsert`/i);
    expect(executingPlans).not.toMatch(
      /Parallel Mode|spec reviewer|code-quality reviewer|JSON block|auto-sync/i,
    );
    expect(executingPlans).not.toMatch(/\bcommit(?:s|ted|ting)?\b/i);

    expect(runtime.skills["executing-plans"]).toEqual(["SKILL.md"]);
    for (const nestedPrompt of nestedPrompts) {
      expect(existsSync(resolve(root, "opencode/arcs/skills/executing-plans", nestedPrompt))).toBe(
        false,
      );
    }
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

  it("keeps worker knowledge capture proposal-only with canonical template syntax", () => {
    const paths = [
      "opencode/arcs/skills/systematic-debugging/SKILL.md",
      "opencode/arcs/skills/writing-knowledge/SKILL.md",
      "opencode/arcs/skills/init-project/SKILL.md",
      "opencode/arcs/skills/enriching-codegraph-proposals/SKILL.md",
    ];

    for (const path of paths) {
      const source = skill(path);
      expect(source).toMatch(/do not execute `?arcs knowledge upsert|proposal-only/i);
      expect(source).not.toMatch(/arcs knowledge template <slug>/i);
    }
  });

  it("makes codegraph enrichment return proposed mutations instead of worker writes", () => {
    const source = skill("opencode/arcs/skills/enriching-codegraph-proposals/SKILL.md");

    expect(source).toMatch(/read-only/i);
    expect(source).toContain("PROPOSED_MUTATIONS:");
    expect(source).toMatch(/orchestrator.*(?:execute|apply)/i);
    expect(source).not.toMatch(/\*\*Read-write skill\.\*\*/i);
  });

  it("keeps deep-review knowledge application behind explicit user authorization", () => {
    const source = skill("opencode/arcs/skills/deep-pr-review/SKILL.md");

    expect(source).toMatch(/do not execute `arcs knowledge upsert`.*explicit user authorization/is);
    expect(source).toMatch(/--body=.*--keywords=.*--source-files=.*--json/i);
  });

  it("routes deep-review performance incidents through software-engineer incident mode", () => {
    const source = skill("opencode/arcs/skills/deep-pr-review/SKILL.md");
    const template = skill("opencode/arcs/skills/deep-pr-review/review-template.md");

    for (const text of [source, template]) {
      expect(text).not.toMatch(/oncall-ops/i);
      expect(text).toMatch(/software-engineer/i);
      expect(text).toMatch(/incident/i);
      expect(text).toMatch(/systematic-debugging/i);
    }
  });

  it("forbids automatic git writes in mutation-related skills", () => {
    const paths = [
      "opencode/arcs/skills/systematic-debugging/SKILL.md",
      "opencode/arcs/skills/test-driven-development/SKILL.md",
      "opencode/arcs/skills/writing-knowledge/SKILL.md",
      "opencode/arcs/skills/init-project/SKILL.md",
      "opencode/arcs/skills/enriching-codegraph-proposals/SKILL.md",
      "opencode/arcs/skills/deep-pr-review/SKILL.md",
    ];

    for (const path of paths) {
      expect(skill(path)).not.toMatch(/git (?:add|commit|push)\b/i);
    }
  });

  it("requires root-cause isolation and a failing regression test before a targeted fix", () => {
    const debugging = skill("opencode/arcs/skills/systematic-debugging/SKILL.md");

    expect(debugging).toMatch(
      /root cause isolat(?:e|ed|ion)[\s\S]*failing (?:regression )?test[\s\S]*targeted fix[\s\S]*scoped (?:tests|verification)[\s\S]*capture/i,
    );
    expect(debugging).not.toMatch(/Applies\|\s*Fix/);
  });

  it("advertises only helper-managed flowchart execution diagrams", () => {
    const diagram = skill("opencode/arcs/skills/to-diagram/SKILL.md");
    const brainstorming = skill("opencode/arcs/skills/brainstorming/SKILL.md");

    expect(diagram).toMatch(/manage-diagram\.mjs[\s\S]*flowchart TD/i);
    expect(diagram).not.toContain("stateDiagram-v2");
    expect(brainstorming).not.toContain("stateDiagram-v2");
    expect(diagram).toMatch(/implementation[\s\S]*work-mode: bounded\|inspect/i);
    expect(diagram).not.toMatch(/quick-dev|code-agent/);
  });

  it("removes the uncalled brainstorming reviewer from disk and runtime inventory", () => {
    const reviewer = resolve(
      root,
      "opencode/arcs/skills/brainstorming/spec-document-reviewer-prompt.md",
    );
    const runtime = JSON.parse(skill("opencode/arcs/bundle-runtime.json"));

    expect(existsSync(reviewer)).toBe(false);
    expect(runtime.skills.brainstorming).not.toContain("spec-document-reviewer-prompt.md");
  });

  it("documents a loopback-only visual companion without a remote binding recipe", () => {
    const companion = skill("opencode/arcs/skills/brainstorming/visual-companion.md");

    expect(companion).toMatch(/loopback-only/i);
    expect(companion).not.toMatch(/--host\s+0\.0\.0\.0/);
  });

  it("makes brainstorming a finite HITL design phase with no authoring authority", () => {
    const brainstorming = skill("opencode/arcs/skills/brainstorming/SKILL.md");

    expect(brainstorming).toMatch(
      /INTAKE[\s\S]*FACT_FINDING[\s\S]*DECISION_LOOP[\s\S]*DESIGN_DRAFT[\s\S]*WAITING_FOR_DESIGN_APPROVAL[\s\S]*PLAN_DRAFT[\s\S]*BRAINSTORM_GATE[\s\S]*WAITING_FOR_EXACT_AUTHORIZATION[\s\S]*AUTHORING/,
    );
    expect(brainstorming).toMatch(/tool-discoverable facts[\s\S]*before asking the user/i);
    expect(brainstorming).toMatch(/one coupled material user-owned decision at a time/i);
    expect(brainstorming).toMatch(
      /completion predicate[\s\S]*goal[\s\S]*scope[\s\S]*non-goals[\s\S]*acceptance[\s\S]*material decisions/i,
    );
    expect(brainstorming).toMatch(/does not require a question|do not ask a question/i);
    expect(brainstorming).toMatch(
      /never[\s\S]*(?:create|write|persist)[\s\S]*plans?[\s\S]*tasks?[\s\S]*diagrams?[\s\S]*knowledge/i,
    );
    expect(brainstorming).not.toMatch(/arcs (?:plan|task|knowledge) (?:create|upsert)/i);
  });

  it("makes writing-plans the sole draft author and requires exact-revision authorization", () => {
    const writingPlans = skill("opencode/arcs/skills/writing-plans/SKILL.md");

    expect(writingPlans).toMatch(/sole authoring owner/i);
    expect(writingPlans).toMatch(
      /approved design[\s\S]*exact plan[\s\S]*task[\s\S]*diagram draft/i,
    );
    expect(writingPlans).toMatch(/plan document reviewer[\s\S]*exact revision/i);
    expect(writingPlans).toMatch(
      /current user[\s\S]*explicitly authorizes[\s\S]*exact revision[\s\S]*devil-advocate[\s\S]*PASS/i,
    );
    expect(writingPlans).toMatch(/material change[\s\S]*invalidates authorization/i);
    expect(writingPlans).toMatch(/outcome-sized[\s\S]*independently verifiable/i);
    expect(writingPlans).toMatch(/no automatic git actions/i);
    expect(writingPlans).not.toMatch(/2-5 minutes|frequent commits|Step 5: Commit/i);
    expect(writingPlans).not.toMatch(/arcs knowledge upsert/i);
  });

  it("reviews the complete plan draft as untrusted data before authorization", () => {
    const reviewer = skill("opencode/arcs/skills/writing-plans/plan-document-reviewer-prompt.md");

    expect(reviewer).toMatch(/complete exact draft/i);
    expect(reviewer).toMatch(/plan[\s\S]*tasks[\s\S]*diagram/i);
    expect(reviewer).toMatch(/outcome-sized[\s\S]*independently verifiable/i);
    expect(reviewer).toMatch(/does not authorize persistence|cannot authorize persistence/i);
  });
});
