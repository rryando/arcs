import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const promptsDir = resolve(import.meta.dirname, "../opencode/arcs/prompts");
const typedAgentPrompts = [
  "arcs-docs.txt",
  "code-reviewer.txt",
  "devil-advocate.txt",
  "graph-explorer.txt",
  "software-engineer.txt",
  "tech-architect.txt",
] as const;

const prompts = Object.fromEntries(
  typedAgentPrompts.map((name) => [name, readFileSync(resolve(promptsDir, name), "utf-8")]),
);

describe("typed-agent prompt contract", () => {
  it("enumerates exactly the six active typed-agent prompts, excluding generated mirrors", () => {
    expect(typedAgentPrompts).toHaveLength(6);
    expect([...typedAgentPrompts]).toEqual(
      readdirSync(promptsDir)
        .filter(
          (name) =>
            name.endsWith(".txt") &&
            !name.startsWith("arcs-orchestrate") &&
            !name.startsWith("arcs-flash"),
        )
        .sort(),
    );
    expect(typedAgentPrompts).not.toContain("arcs-orchestrate.txt");
    expect(typedAgentPrompts).not.toContain("arcs-orchestrate-caveman.txt");
  });

  it.each(typedAgentPrompts)("keeps untrusted artifacts below dispatch authority: %s", (name) => {
    const prompt = prompts[name];

    expect(prompt).toMatch(/untrusted.*reference data|reference data.*untrusted/i);
    expect(prompt).toMatch(
      /embedded instructions.*cannot override|cannot override.*embedded instructions/i,
    );
    expect(prompt).toMatch(/SCOPE.*GOAL.*CONSTRAINTS.*SKILL.*VERIFY/i);
  });

  it.each(
    typedAgentPrompts,
  )("keeps a substantive, idempotent knowledge command contract: %s", (name) => {
    const prompt = prompts[name];
    const commands = [...prompt.matchAll(/arcs knowledge upsert <slug>[^\n]*/g)].map(
      ([command]) => command,
    );

    expect(prompt).toMatch(
      /arcs knowledge upsert[\s\S]{0,500}--kind=.*--summary=.*--body=.*--keywords=.*--source-files=.*--json/,
    );
    expect(prompt).toContain("arcs knowledge template --kind=<kind> --json");
    expect(prompt).toMatch(/idempotent.*title|title.*idempotent/i);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toMatch(/--kind=.*--summary=.*--body=.*--keywords=.*--source-files=.*--json/);
    }
  });

  it.each([
    "software-engineer.txt",
    "tech-architect.txt",
  ] as const)("returns knowledge upserts for orchestrator persistence instead of executing them: %s", (name) => {
    const prompt = prompts[name];

    expect(prompt).toMatch(/do not execute `arcs knowledge upsert`/i);
    expect(prompt).toMatch(/ready-to-run.*proposal/i);
    expect(prompt).toMatch(/orchestrator.*persist.*fan-in/i);
    expect(prompt).toMatch(
      /KNOWLEDGE:[^\n]*arcs knowledge upsert <slug>[^\n]*--kind=.*--summary=.*--body=.*--keywords=.*--source-files=.*--json/i,
    );
  });

  it("makes arcs-docs SYNC a gated read-only AUDIT followed by approved APPLY", () => {
    const prompt = prompts["arcs-docs.txt"];
    const audit = prompt.slice(
      prompt.indexOf("### PHASE: AUDIT"),
      prompt.indexOf("### PHASE: APPLY"),
    );
    const apply = prompt.slice(
      prompt.indexOf("### PHASE: APPLY"),
      prompt.indexOf("### Audit Surfaces"),
    );

    expect(audit).toMatch(/strictly read-only/i);
    expect(audit).toContain("PROPOSED_MUTATIONS:");
    expect(audit).not.toMatch(
      /```bash[\s\S]*(?:knowledge upsert|task transition|plan update-meta|project write-checkpoint)/i,
    );
    expect(apply).toMatch(/SYNC gate.*PASS/i);
    expect(apply).toMatch(/only.*approved.*PROPOSED_MUTATIONS/i);
    expect(apply).toMatch(/validate[\s\S]*write-checkpoint/i);
    expect(prompt).toMatch(/AUDIT.*must not mutate|must not mutate.*AUDIT/i);
    expect(prompt).toMatch(/Outside approved SYNC APPLY[\s\S]*read-only proposal tasks/i);
  });

  it("reserves direct knowledge mutation for approved arcs-docs SYNC APPLY", () => {
    for (const name of typedAgentPrompts.filter((name) => name !== "arcs-docs.txt")) {
      const prompt = prompts[name];
      expect(prompt).toMatch(
        /(?:do not execute|proposal-only|never write).*arcs knowledge upsert|arcs knowledge upsert.*(?:do not execute|proposal-only)/i,
      );
    }

    expect(prompts["arcs-docs.txt"]).toMatch(/only approved SYNC APPLY.*arcs knowledge upsert/i);
  });

  it("preserves oncall's diagnosis-first scoped repair authority in software-engineer incident mode", () => {
    const prompt = prompts["software-engineer.txt"];

    expect(prompt).toMatch(/AGENT_MODE: incident/i);
    expect(prompt).toMatch(/systematic-debugging.*mandatory/i);
    expect(prompt).toMatch(/no fixes without root cause investigation first/i);
    expect(prompt).toMatch(/reproduc.*before.*fix/i);
    expect(prompt).toMatch(/one variable/i);
    expect(prompt).toMatch(/3 failed fixes.*stop/i);
    expect(prompt).toMatch(/scoped regression test/i);
    expect(prompt).toMatch(/ROOT_CAUSE:[\s\S]*EVIDENCE:[\s\S]*FIX:[\s\S]*REGRESSION_RISK:/);
    expect(prompt).toMatch(/never run `arcs task transition`/i);
  });

  it("uses consolidated implementation modes and embedded minimalism in software-engineer", () => {
    const prompt = prompts["software-engineer.txt"];

    expect(prompt).toMatch(/implementation[\s\S]*bounded[\s\S]*inspect/i);
    expect(prompt).not.toMatch(/quick-dev|code-agent|the-ladder/);
    expect(prompt).toMatch(
      /necessity[\s\S]*standard library[\s\S]*native platform[\s\S]*installed dependenc[\s\S]*minimum code/i,
    );
    expect(prompt).toMatch(/security[\s\S]*accessibility[\s\S]*data loss/i);
    expect(prompt).toContain("// SHORTCUT: <ceiling>, upgrade when <trigger>");
    expect(prompt).toMatch(/arcs task update[^\n]*\| Propose[^\n]*do not execute/i);
  });

  it("owns review prerequisites, checklist, and recurring finding proposals in code-reviewer", () => {
    const prompt = prompts["code-reviewer.txt"];

    expect(prompt).not.toContain("requesting-code-review");
    expect(prompt).toMatch(
      /WHAT_WAS_IMPLEMENTED[\s\S]*PLAN_OR_REQUIREMENTS[\s\S]*BASE_SHA[\s\S]*HEAD_SHA/i,
    );
    expect(prompt).toMatch(
      /review checklist[\s\S]*project conventions[\s\S]*code quality[\s\S]*architecture[\s\S]*testing[\s\S]*requirements[\s\S]*production readiness/i,
    );
    expect(prompt).toMatch(/recurring defect class[\s\S]*KNOWLEDGE/i);
    expect(prompt).toMatch(/CRITICAL\/HIGH[\s\S]*owning implementer/i);
    expect(prompt).toMatch(/optional.*review|review.*optional/i);
    expect(prompt).toMatch(/propose.*knowledge|knowledge.*propose/i);
    expect(prompt).not.toMatch(
      /never write or edit knowledge yourself[\s\S]*arcs knowledge upsert[^\n]*\n/i,
    );
  });

  it("preserves tech-architect's read-only design authority", () => {
    const prompt = prompts["tech-architect.txt"];

    expect(prompt).toMatch(/you read and reason; you never write implementation code/i);
    expect(prompt).toMatch(/you still mutate nothing directly/i);
    expect(prompt).toMatch(/you do not execute these mutations yourself/i);
    expect(prompt).not.toMatch(/\bfind-docs\b/i);
    expect(prompt).toMatch(
      /plans?.*diagrams?.*(?:proposal|draft)|(?:proposal|draft).*plans?.*diagrams?/i,
    );
    expect(prompt).not.toMatch(/ARTIFACTS:[\s\S]*executed:/i);
  });

  it("folds cited DAG-first research into read-only tech-architect research mode", () => {
    const prompt = prompts["tech-architect.txt"];

    expect(prompt).toMatch(/AGENT_MODE: research/i);
    expect(prompt).toMatch(/DAG-first/i);
    expect(prompt).toMatch(/cite sources.*external|external.*citations/i);
    expect(prompt).toMatch(/reference.*feature.*knowledge proposal/i);
    expect(prompt).toMatch(/no file or DAG writes/i);
    expect(prompt).toMatch(/RESEARCH:[\s\S]*FINDINGS:[\s\S]*GAPS:/);
  });

  it("uses canonical full-project verification only at the completion gate", () => {
    const prompt = prompts["devil-advocate.txt"];
    const completion = prompt.slice(
      prompt.indexOf("### PHASE: completion"),
      prompt.indexOf("## Verdict Format"),
    );
    const execute = prompt.slice(
      prompt.indexOf("### PHASE: execute"),
      prompt.indexOf("### PHASE: sync"),
    );

    expect(completion).toContain("`npm test`");
    expect(completion).toContain("`npm run typecheck`");
    expect(completion).toContain("`npm run lint`");
    expect(execute).toMatch(/ONLY the scoped VERIFY command forwarded/i);
    expect(execute).not.toMatch(/npm test|npm run typecheck|npm run lint/);
    expect(prompt).toMatch(/mandatory.*non-interactive|non-interactive.*mandatory/i);
    expect(prompt).toMatch(/only completion verifier|completion verifier.*only/i);
    expect(prompt).toMatch(
      /STATUS:[\s\S]*FILES_TOUCHED:[\s\S]*VERIFY:[\s\S]*BLOCKED_BY:[\s\S]*KNOWLEDGE:/,
    );
    const verdictFormat = prompt.slice(prompt.indexOf("## Verdict Format"));
    expect(verdictFormat.indexOf("STATUS:")).toBeLessThan(verdictFormat.indexOf("PHASE:"));
    expect(prompt).not.toMatch(/work-agent Standard Return Envelope/i);
  });

  it("keeps graph-explorer DAG-first with a concise bounded source fallback", () => {
    const prompt = prompts["graph-explorer.txt"];
    const fallback = prompt.slice(
      prompt.indexOf("### LAST RESORT"),
      prompt.indexOf("## Quality Gate"),
    );

    expect(prompt).toMatch(/supplied context[\s\S]*DAG[\s\S]*codegraph[\s\S]*source/i);
    expect(prompt).toContain("DAG GAP:");
    expect(prompt).not.toContain("DAG FAILURE DECLARATION");
    expect(fallback).toMatch(/after.*DAG.*codegraph.*(?:cannot answer|fail)/i);
    expect(fallback).toMatch(/smallest targeted.*file.*path.*symbol/i);
    expect(fallback).toMatch(/explicit question/i);
    expect(fallback).toMatch(/blocked.*fallback fails|fallback fails.*blocked/i);
    expect(fallback).toMatch(/never.*open-ended scanning/i);
    expect(prompt).toMatch(/\[DAG\].*\[GRAPH\].*\[FILE\]|DAG.*GRAPH.*FILE/s);
    expect(prompt).toMatch(/do not require.*DAG|DAG.*not required/i);
    expect(prompt).toMatch(/propose.*knowledge|knowledge.*proposal/i);
  });

  it("calibrates minimalism findings by material impact", () => {
    const reviewer = prompts["code-reviewer.txt"];
    const gate = prompts["devil-advocate.txt"];

    for (const prompt of [reviewer, gate]) {
      expect(prompt).toMatch(
        /material.*(?:complexity|duplication|speculative)|(?:complexity|duplication|speculative).*material/i,
      );
      expect(prompt).toMatch(
        /ordinary.*(?:style|bloat).*(?:warn|non-blocking)|(?:warn|non-blocking).*ordinary.*(?:style|bloat)/i,
      );
    }
  });
});
