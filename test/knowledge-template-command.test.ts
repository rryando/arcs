// ---------------------------------------------------------------------------
// Tests for the project-independent `knowledge template` CLI command:
//   - emits structured sections + fillable markdown skeleton per kind
//   - validates --kind against the canonical kind enum
//   - requires no slug positional (project-independent)
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { CLIResult } from "../src/cli/command-registry.js";
import { KNOWLEDGE_KINDS } from "../src/utils/storage-utils.js";
import { runCommand } from "./helpers/cli-runner.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

type TemplateData = {
  kind: string;
  sections: { heading: string; hint: string }[];
  markdown: string;
};

function dataOf(result: CLIResult): TemplateData {
  expect(result.ok).toBe(true);
  return (result as { ok: true; data: unknown }).data as TemplateData;
}

describe("knowledge template --kind", () => {
  it("gotcha → ok with Symptom section and matching markdown heading", async () => {
    await withTempDataDir(async () => {
      const result = await runCommand("knowledge template", ["--kind=gotcha", "--json"]);
      const data = dataOf(result);
      expect(data.kind).toBe("gotcha");
      expect(data.sections.some((s) => s.heading === "Symptom")).toBe(true);
      expect(data.markdown).toContain("## Symptom");
    });
  });

  it("decision → sections include Alternatives rejected", async () => {
    await withTempDataDir(async () => {
      const result = await runCommand("knowledge template", ["--kind=decision", "--json"]);
      const data = dataOf(result);
      expect(data.kind).toBe("decision");
      expect(data.sections.some((s) => s.heading === "Alternatives rejected")).toBe(true);
      expect(data.markdown).toContain("## Alternatives rejected");
    });
  });

  it("rejects an invalid --kind value", async () => {
    await withTempDataDir(async () => {
      const result = await runCommand("knowledge template", ["--kind=bogus", "--json"]);
      expect(result.ok).toBe(false);
    });
  });

  it("requires --kind", async () => {
    await withTempDataDir(async () => {
      const result = await runCommand("knowledge template", ["--json"]);
      expect(result.ok).toBe(false);
    });
  });

  it("every supported kind returns ok with non-empty sections and markdown", async () => {
    await withTempDataDir(async () => {
      for (const kind of KNOWLEDGE_KINDS) {
        const result = await runCommand("knowledge template", [`--kind=${kind}`, "--json"]);
        const data = dataOf(result);
        expect(data.kind).toBe(kind);
        expect(data.sections.length).toBeGreaterThan(0);
        expect(data.markdown.length).toBeGreaterThan(0);
        // Each section heading is rendered into the markdown skeleton.
        for (const section of data.sections) {
          expect(data.markdown).toContain(`## ${section.heading}`);
        }
      }
    });
  });
});
