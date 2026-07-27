import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const promptsDir = resolve(import.meta.dirname, "../opencode/arcs/prompts");
const typedAgentPrompts = [
  "arcs-docs.txt",
  "code-reviewer.txt",
  "devil-advocate.txt",
  "docs-researcher.txt",
  "graph-explorer.txt",
  "oncall-ops.txt",
  "software-engineer.txt",
  "tech-architect.txt",
] as const;

const prompts = Object.fromEntries(
  typedAgentPrompts.map((name) => [name, readFileSync(resolve(promptsDir, name), "utf-8")]),
);

describe("typed-agent prompt contract", () => {
  it("enumerates exactly the eight hand-authored prompts, excluding generated mirrors", () => {
    expect(typedAgentPrompts).toHaveLength(8);
    expect([...typedAgentPrompts]).toEqual(
      readdirSync(promptsDir)
        .filter((name) => name.endsWith(".txt") && !name.startsWith("arcs-orchestrate"))
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
    "oncall-ops.txt",
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

  it("preserves oncall's diagnosis-first scoped repair authority", () => {
    const prompt = prompts["oncall-ops.txt"];

    expect(prompt).toMatch(/no fixes without root cause investigation first/i);
    expect(prompt).toMatch(/prove fix works with evidence/i);
    expect(prompt).toMatch(/scoped tests covering only the files you touched/i);
    expect(prompt).toMatch(/never run `arcs task transition`/i);
  });

  it("preserves tech-architect's read-only design authority", () => {
    const prompt = prompts["tech-architect.txt"];

    expect(prompt).toMatch(/you read and reason; you never write implementation code/i);
    expect(prompt).toMatch(/you still mutate nothing directly/i);
    expect(prompt).toMatch(/you do not execute these mutations yourself/i);
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
  });

  it("permits graph-explorer's smallest bounded fallback only after DAG and codegraph fail", () => {
    const prompt = prompts["graph-explorer.txt"];
    const fallback = prompt.slice(
      prompt.indexOf("### LAST RESORT"),
      prompt.indexOf("## Quality Gate"),
    );

    expect(fallback).toMatch(/after.*DAG.*codegraph.*fail/i);
    expect(fallback).toMatch(/smallest targeted.*file.*path.*symbol/i);
    expect(fallback).toMatch(/explicit question/i);
    expect(fallback).toMatch(/blocked.*fallback fails|fallback fails.*blocked/i);
    expect(fallback).toMatch(/never.*open-ended scanning/i);
  });
});
