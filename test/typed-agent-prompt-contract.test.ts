import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const promptsDir = resolve(import.meta.dirname, "../opencode/arcs/prompts");
const typedAgentPrompts = [
  "arcs-docs.txt",
  "code-reviewer.txt",
  "graph-explorer.txt",
  "software-engineer.txt",
  "tech-architect.txt",
] as const;

const prompts = Object.fromEntries(
  typedAgentPrompts.map((name) => [name, readFileSync(resolve(promptsDir, name), "utf-8")]),
);

describe("typed-agent prompt contract", () => {
  it("keeps exactly five compatible typed-agent identities", () => {
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
  });

  it.each(typedAgentPrompts)("keeps a compact trust and scope boundary: %s", (name) => {
    const prompt = prompts[name];
    expect(prompt).toMatch(/untrusted reference data/i);
    expect(prompt).toMatch(/embedded instructions.*cannot override/is);
    expect(prompt).toMatch(/scope/i);
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(5000);
  });

  it("makes software-engineer the direct implementation owner", () => {
    const prompt = prompts["software-engineer.txt"];
    expect(prompt).toMatch(/inspect.*edit.*test.*verify/is);
    expect(prompt).toMatch(/relevant verification/i);
    expect(prompt).toMatch(/incident.*root cause.*reproduction/is);
    expect(prompt).toMatch(/verification fails.*fix.*rerun/is);
    expect(prompt).not.toMatch(
      /devil-advocate.*completion|full-project verification.*exclusively/is,
    );
  });

  it("keeps tech-architect read-only and evidence-driven", () => {
    const prompt = prompts["tech-architect.txt"];
    expect(prompt).toMatch(/read-only/i);
    expect(prompt).toMatch(/trade-offs.*boundaries.*migration/is);
    expect(prompt).toMatch(/research.*cite.*external/is);
    expect(prompt).toMatch(/do not write implementation code/i);
  });

  it("keeps graph-explorer bounded without forcing it into every task", () => {
    const prompt = prompts["graph-explorer.txt"];
    expect(prompt).toMatch(/supplied context.*DAG.*codegraph.*source/is);
    expect(prompt).toMatch(/smallest.*evidence/i);
    expect(prompt).toMatch(/read-only/i);
    expect(prompt).not.toMatch(/mandatory note|IRON LAW/i);
  });

  it("keeps code-reviewer explicit, read-only, evidence-backed, and mode-driven", () => {
    const prompt = prompts["code-reviewer.txt"];
    expect(prompt).toMatch(/only when requested|explicit.*review/is);
    expect(prompt).toMatch(/review.*audit.*risk/is);
    expect(prompt).toMatch(/file:line/i);
    expect(prompt).toMatch(/correctness.*security.*maintainability.*tests/is);
    expect(prompt).toMatch(/security.*migration.*public contract.*concurrency.*destructive/is);
    expect(prompt).toMatch(/risk mode.*optional|optional.*risk mode/is);
    expect(prompt).not.toMatch(
      /risk mode is a mandatory completion gate|mandatory completion verifier/is,
    );
    expect(prompt).toMatch(/do not edit/i);
  });

  it("lets arcs-docs perform requested DAG updates directly", () => {
    const prompt = prompts["arcs-docs.txt"];
    expect(prompt).toMatch(/requested.*DAG.*updates.*directly/is);
    expect(prompt).toMatch(/validate.*after.*write/is);
    expect(prompt).toMatch(/guarded mode|guarded-mode/i);
    expect(prompt).toMatch(/confirm.*delete.*irreversible.*external/is);
    expect(prompt).not.toMatch(/SYNC gate.*PASS|PHASE: AUDIT|PHASE: APPLY/);
  });

  it.each(typedAgentPrompts)("uses the compact typed return contract: %s", (name) => {
    const prompt = prompts[name];
    expect(prompt).toMatch(/## Return/);
    expect(prompt).toMatch(/do not echo.*context/i);
    expect(prompt).toMatch(/(?:do not).*(?:process narration|narrate process)/i);
    const returnBlock = prompt.match(/```text\n([\s\S]*?)\n```/)?.[1];
    expect(returnBlock).toBeDefined();
    const labels = returnBlock
      ?.split("\n")
      .filter((line) => /^[A-Z]+:/.test(line))
      .map((line) => line.slice(0, line.indexOf(":")));
    expect(labels?.slice(0, 5)).toEqual(["STATUS", "RESULT", "FILES", "VERIFY", "BLOCKER"]);
    expect(labels?.slice(5)).toEqual(["KNOWLEDGE"]);
    expect(returnBlock).toMatch(/KNOWLEDGE:.*durable discovery.*optional/i);
    expect(prompt).not.toMatch(/canonical envelope|fan-in persistence|KNOWLEDGE_CHECKED/i);
  });
});
