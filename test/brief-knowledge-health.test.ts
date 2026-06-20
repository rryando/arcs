// ---------------------------------------------------------------------------
// Tests for `arcs brief` knowledgeHealth signal + renderer line.
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderBrief } from "../src/cli/brief-renderer.js";
import { runCommand } from "./helpers/cli-runner.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

function daysAgoISO(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function seedProject(dir: string, slug: string, knowledge: unknown[]) {
  const rootMeta = {
    version: "1.0",
    projects: [{ id: slug, name: "Test Project", status: "active", dependsOn: [] }],
  };
  writeFileSync(resolve(dir, "meta.json"), JSON.stringify(rootMeta), "utf-8");
  const projDir = resolve(dir, "projects", slug);
  mkdirSync(projDir, { recursive: true });
  writeFileSync(
    resolve(projDir, "meta.json"),
    JSON.stringify({
      id: slug,
      name: "Test Project",
      description: "A test project",
      createdAt: "2025-01-01T00:00:00Z",
      workspacePaths: [process.cwd()],
    }),
    "utf-8",
  );
  writeFileSync(resolve(projDir, "overview.md"), "Summary paragraph.", "utf-8");
  mkdirSync(resolve(projDir, "tasks"), { recursive: true });
  mkdirSync(resolve(projDir, "plans"), { recursive: true });
  writeFileSync(resolve(projDir, "plans", "index.json"), JSON.stringify({ plans: [] }), "utf-8");
  const knowledgeDir = resolve(projDir, "knowledge");
  mkdirSync(knowledgeDir, { recursive: true });
  writeFileSync(
    resolve(knowledgeDir, "index.json"),
    JSON.stringify({ entries: knowledge }),
    "utf-8",
  );
  for (const k of knowledge as Array<{ normalizedId: string }>) {
    writeFileSync(resolve(knowledgeDir, `${k.normalizedId}.meta.json`), JSON.stringify(k), "utf-8");
  }
}

function entry(over: Record<string, unknown>) {
  return {
    keywords: [],
    summary: "complete",
    sourceFiles: [{ path: "src/a.ts" }],
    file: "knowledge/x.md",
    createdAt: daysAgoISO(1),
    updatedAt: daysAgoISO(1),
    audience: "universal",
    ...over,
  };
}

describe("arcs brief knowledgeHealth payload", () => {
  it("counts total, thin, and stale entries", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "bkh-proj", [
        entry({ id: "k1", normalizedId: "k1", title: "Healthy", kind: "lesson" }),
        entry({ id: "k2", normalizedId: "k2", title: "Thin", kind: "lesson", summary: "" }),
        entry({
          id: "k3",
          normalizedId: "k3",
          title: "Stale",
          kind: "lesson",
          updatedAt: daysAgoISO(400),
        }),
      ]);
      const result = await runCommand("brief", ["bkh-proj", "--json"]);
      expect(result.ok).toBe(true);
      const data = result.data as {
        knowledgeHealth: { total: number; thin: number; stale: number };
      };
      expect(data.knowledgeHealth).toEqual({ total: 3, thin: 1, stale: 1 });
    });
  });

  it("reports zeros when all entries are healthy", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "bkh-ok", [
        entry({ id: "k1", normalizedId: "k1", title: "Healthy", kind: "lesson" }),
      ]);
      const result = await runCommand("brief", ["bkh-ok", "--json"]);
      const data = result.data as {
        knowledgeHealth: { total: number; thin: number; stale: number };
      };
      expect(data.knowledgeHealth).toEqual({ total: 1, thin: 0, stale: 0 });
    });
  });
});

describe("renderBrief knowledge health line", () => {
  const base = {
    slug: "x",
    name: "X",
    summary: "",
    operatingBrief: { currentFocus: "a", recommendedSurface: "b", why: "c", nextAction: "d" },
    activePlansCount: 0,
    openTasksCount: 0,
    topKnowledge: [],
  };

  it("renders a single line when thin>0", () => {
    const md = renderBrief({ ...base, knowledgeHealth: { total: 5, thin: 2, stale: 0 } });
    expect(md).toContain("## Knowledge Health");
    expect(md).toContain("2 thin, 0 stale of 5 entries");
  });

  it("renders a single line when stale>0", () => {
    const md = renderBrief({ ...base, knowledgeHealth: { total: 4, thin: 0, stale: 1 } });
    expect(md).toContain("## Knowledge Health");
    expect(md).toContain("0 thin, 1 stale of 4 entries");
  });

  it("omits the section when thin=0 and stale=0", () => {
    const md = renderBrief({ ...base, knowledgeHealth: { total: 3, thin: 0, stale: 0 } });
    expect(md).not.toContain("## Knowledge Health");
  });

  it("omits the section when knowledgeHealth is absent", () => {
    const md = renderBrief(base);
    expect(md).not.toContain("## Knowledge Health");
  });
});
