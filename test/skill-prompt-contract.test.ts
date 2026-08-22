import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const skillsRoot = resolve(root, "opencode/arcs/skills");

function read(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

function markdownFiles(path: string): string[] {
  return readdirSync(path).flatMap((name) => {
    const entry = join(path, name);
    return statSync(entry).isDirectory()
      ? markdownFiles(entry)
      : entry.endsWith(".md")
        ? [entry]
        : [];
  });
}

describe("lean skill contracts", () => {
  it("keeps exactly eleven bundled skill identities", () => {
    const names = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(names).toHaveLength(11);
    expect(names).toContain("implementation");
    expect(names).toContain("brainstorming");
    expect(names).toContain("writing-plans");
    expect(names).toContain("deep-pr-review");
    expect(names).not.toContain("executing-plans");
  });

  it("keeps every skill and reference compact", () => {
    for (const path of markdownFiles(skillsRoot)) {
      expect(Buffer.byteLength(readFileSync(path), "utf8"), path).toBeLessThanOrEqual(5000);
    }
  });

  it("uses brainstorming only for material design uncertainty", () => {
    const source = read("opencode/arcs/skills/brainstorming/SKILL.md");
    expect(source).toMatch(/material.*design.*uncertainty|design.*material.*uncertainty/is);
    expect(source).toMatch(/resolve.*repository.*facts.*before.*ask/is);
    expect(source).toMatch(/ask.*only.*material.*decision/is);
    expect(source).toMatch(/approve.*design/is);
    expect(source).not.toMatch(/BRAINSTORM_GATE|WAITING_FOR_EXACT_AUTHORIZATION|sole owner/i);
  });

  it("lets an explicit plan request authorize persistence", () => {
    const source = read("opencode/arcs/skills/writing-plans/SKILL.md");
    expect(source).toMatch(/explicit.*plan request.*authoriz.*persist/is);
    expect(source).toMatch(/outcome-sized.*independently verifiable/is);
    expect(source).toMatch(/exact paths.*verification.*dependencies/is);
    expect(source).toMatch(/diagram.*derived.*task metadata/is);
    expect(source).not.toMatch(
      /devil-advocate.*PASS|exact-revision authorization|mandatory reviewer/i,
    );
  });

  it("keeps bounded, inspect, and plan-node implementation direct", () => {
    const implementation = read("opencode/arcs/skills/implementation/SKILL.md");
    expect(implementation).toMatch(/inspect.*edit.*verify/is);
    expect(implementation).toMatch(/bounded.*inspect.*plan-node.*hints/is);
    expect(implementation).toMatch(/plan-node.*dependencies.*ready node.*verif/is);
    expect(implementation).toMatch(/task.*diagram.*ARCS CLI/is);
    expect(implementation).toMatch(/goal.*material scope.*dependency strategy.*risk/is);
    expect(implementation).toMatch(/verification fails.*fix.*rerun/is);
  });

  it("uses proportionate testing and systematic debugging", () => {
    const tdd = read("opencode/arcs/skills/test-driven-development/SKILL.md");
    const debugging = read("opencode/arcs/skills/systematic-debugging/SKILL.md");
    expect(tdd).toMatch(/behavior change.*failing test.*minimal.*refactor/is);
    expect(tdd).toMatch(/mechanical|prose|metadata/i);
    expect(tdd).not.toMatch(/delete it.*start fresh|IRON LAW/i);
    expect(debugging).toMatch(/observe.*reproduce.*isolate.*regression test.*fix.*verify/is);
    expect(debugging).toMatch(/three failed.*stop.*architecture/is);
    expect(debugging).not.toMatch(/knowledge.*mandatory|devil-advocate.*completion/i);
  });

  it("preserves diagram and knowledge integrity without reviewer ownership", () => {
    const diagram = read("opencode/arcs/skills/to-diagram/SKILL.md");
    const knowledge = read("opencode/arcs/skills/writing-knowledge/SKILL.md");
    expect(diagram).toMatch(/task metadata.*source of truth/is);
    expect(diagram).toMatch(/manage-diagram\.mjs.*flowchart TD/is);
    expect(diagram).toMatch(/validate.*after.*write/is);
    expect(diagram).not.toMatch(/devil-advocate.*owns|only orchestrator/i);
    expect(knowledge).toMatch(/summary.*body.*source files/is);
    expect(knowledge).toMatch(/requested.*write.*directly|directly.*requested.*write/is);
  });

  it("keeps initialization and codegraph enrichment simple", () => {
    const init = read("opencode/arcs/skills/init-project/SKILL.md");
    const enrichment = read("opencode/arcs/skills/enriching-codegraph-proposals/SKILL.md");
    expect(init).toMatch(/explicit.*init.*authoriz/is);
    expect(init).toMatch(/codegraph.*optional/is);
    expect(init).not.toMatch(/fan out.*mandatory|devil-advocate.*gate/is);
    expect(enrichment).toMatch(/keep.*merge.*drop/is);
    expect(enrichment).toMatch(/source files.*evidence/is);
    expect(enrichment).not.toMatch(/devil-advocate|orchestrator applies approved/i);
  });

  it("keeps external and destructive effects confirmed at the boundary", () => {
    const deepReview = read("opencode/arcs/skills/deep-pr-review/SKILL.md");
    expect(deepReview).toMatch(/read-only.*until.*user.*confirm/is);
    expect(deepReview).toMatch(/one.*GitHub.*write/is);
    expect(deepReview).toMatch(/cached.*diff/is);
  });

  it("keeps nested references optional and safe", () => {
    const reviewer = read("opencode/arcs/skills/writing-plans/plan-document-reviewer-prompt.md");
    const companion = read("opencode/arcs/skills/brainstorming/visual-companion.md");
    const codegraph = read("opencode/arcs/skills/deep-pr-review/codegraph-diff.md");
    expect(reviewer).toMatch(/optional/i);
    expect(reviewer).toMatch(/untrusted reference data/i);
    expect(companion).toMatch(/loopback-only/i);
    expect(codegraph).toMatch(/cached.*diff/i);
    expect(codegraph).not.toMatch(/gh pr diff/);
  });

  it("keeps root skills aligned with delegation-preferred behavior", () => {
    const orchestrate = read("skills/orchestrate.md");
    const explore = read("skills/explore-dag.md");
    const init = read("skills/init-project.md");
    const docs = read("skills/update-docs.md");
    expect(orchestrate).toMatch(/UNDERSTAND.*WORK.*VERIFY.*REPORT/is);
    expect(orchestrate).toMatch(/strongly prefer.*delegat.*separable/is);
    expect(explore).toMatch(/use.*graph-explorer.*only when|graph-explorer.*optional/is);
    expect(init).not.toMatch(/devil-advocate|exact authorization/i);
    expect(docs).not.toMatch(/two-pass|devil-advocate/i);
  });

  it("does not restore retired skills", () => {
    for (const name of ["quick-dev", "code-agent", "requesting-code-review", "the-ladder"]) {
      expect(existsSync(resolve(skillsRoot, name))).toBe(false);
    }
  });
});
