// ---------------------------------------------------------------------------
// Tests for the `knowledge-health` validate check (thin/stale metadata).
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "./helpers/cli-runner.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

interface ValidationIssue {
  severity: string;
  kind: string;
  message: string;
  safeToAutoRepair?: boolean;
}

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
    JSON.stringify({ id: slug, name: "Test Project", workspacePaths: [] }),
    "utf-8",
  );
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

function healthOf(result: { ok: boolean; data: unknown }) {
  const data = result.data as { issues: ValidationIssue[] };
  return data.issues;
}

describe("validate knowledge-health check", () => {
  it("emits thin_knowledge when summary is missing", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "kh-thin", [
        {
          id: "k1",
          normalizedId: "k1",
          title: "No Summary",
          kind: "lesson",
          keywords: [],
          summary: "",
          sourceFiles: [{ path: "src/a.ts" }],
          file: "knowledge/k1.md",
          createdAt: daysAgoISO(1),
          updatedAt: daysAgoISO(1),
        },
      ]);
      const result = await runCommand("validate", ["kh-thin", "--checks=knowledge-health"]);
      expect(result.ok).toBe(true);
      const issues = healthOf(result as { ok: boolean; data: unknown });
      const thin = issues.find((iss) => iss.kind === "thin_knowledge");
      expect(thin).toBeDefined();
      expect(thin!.message).toContain("No Summary");
      expect(thin!.message).toContain("summary");
      expect(thin!.safeToAutoRepair).toBe(false);
    });
  });

  it("emits thin_knowledge when sourceFiles is missing", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "kh-thin2", [
        {
          id: "k1",
          normalizedId: "k1",
          title: "No Sources",
          kind: "lesson",
          keywords: [],
          summary: "Has a summary",
          file: "knowledge/k1.md",
          createdAt: daysAgoISO(1),
          updatedAt: daysAgoISO(1),
        },
      ]);
      const result = await runCommand("validate", ["kh-thin2", "--checks=knowledge-health"]);
      const issues = healthOf(result as { ok: boolean; data: unknown });
      const thin = issues.find((iss) => iss.kind === "thin_knowledge");
      expect(thin).toBeDefined();
      expect(thin!.message).toContain("source-files");
    });
  });

  it("emits stale_knowledge when updatedAt is older than 180 days", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "kh-stale", [
        {
          id: "k1",
          normalizedId: "k1",
          title: "Old Entry",
          kind: "lesson",
          keywords: [],
          summary: "complete",
          sourceFiles: [{ path: "src/a.ts" }],
          file: "knowledge/k1.md",
          createdAt: daysAgoISO(400),
          updatedAt: daysAgoISO(400),
        },
      ]);
      const result = await runCommand("validate", ["kh-stale", "--checks=knowledge-health"]);
      const issues = healthOf(result as { ok: boolean; data: unknown });
      const stale = issues.find((iss) => iss.kind === "stale_knowledge");
      expect(stale).toBeDefined();
      expect(stale!.message).toMatch(/\d+ days/);
      expect(stale!.safeToAutoRepair).toBe(false);
      // A complete-but-old entry must NOT be flagged thin
      expect(issues.find((iss) => iss.kind === "thin_knowledge")).toBeUndefined();
    });
  });

  it("does not flag a healthy, recent entry", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "kh-ok", [
        {
          id: "k1",
          normalizedId: "k1",
          title: "Healthy",
          kind: "lesson",
          keywords: [],
          summary: "complete",
          sourceFiles: [{ path: "src/a.ts" }],
          file: "knowledge/k1.md",
          createdAt: daysAgoISO(1),
          updatedAt: daysAgoISO(1),
        },
      ]);
      const result = await runCommand("validate", ["kh-ok", "--checks=knowledge-health"]);
      const issues = healthOf(result as { ok: boolean; data: unknown });
      expect(issues.filter((iss) => iss.kind === "thin_knowledge")).toHaveLength(0);
      expect(issues.filter((iss) => iss.kind === "stale_knowledge")).toHaveLength(0);
    });
  });

  it("does not emit stale_knowledge_source (that is a separate check)", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "kh-sep", [
        {
          id: "k1",
          normalizedId: "k1",
          title: "Thin",
          kind: "lesson",
          keywords: [],
          summary: "",
          file: "knowledge/k1.md",
          createdAt: daysAgoISO(1),
          updatedAt: daysAgoISO(1),
        },
      ]);
      const result = await runCommand("validate", ["kh-sep", "--checks=knowledge-health"]);
      const issues = healthOf(result as { ok: boolean; data: unknown });
      expect(issues.find((iss) => iss.kind === "stale_knowledge_source")).toBeUndefined();
    });
  });

  it("--checks=all includes knowledge-health", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "kh-all", [
        {
          id: "k1",
          normalizedId: "k1",
          title: "Thin All",
          kind: "lesson",
          keywords: [],
          summary: "",
          file: "knowledge/k1.md",
          createdAt: daysAgoISO(1),
          updatedAt: daysAgoISO(1),
        },
      ]);
      const result = await runCommand("validate", ["kh-all"]);
      const issues = healthOf(result as { ok: boolean; data: unknown });
      expect(issues.find((iss) => iss.kind === "thin_knowledge")).toBeDefined();
    });
  });
});
