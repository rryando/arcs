// ---------------------------------------------------------------------------
// Tests for the write-time shallow-body guard on knowledge body-writing paths:
//   - knowledge create     — warns on shallow body, --allow-thin suppresses
//   - knowledge upsert      — warns on shallow body, --allow-thin suppresses
//   - knowledge update-body — warns on shallow body, --allow-thin suppresses
//
// Contract: the guard is WARN-ONLY. A shallow body still writes (ok:true) and
// surfaces `data.warnings` (a string[] matching /shallow body/). With a rich
// body or --allow-thin there is NO `warnings` key. Mirrors the same
// `isBodyShallow` primitive the knowledge-health validator uses.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CLIResult } from "../src/cli/command-registry.js";
import { runCommand } from "./helpers/cli-runner.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

function seedProject(dir: string, slug: string) {
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
  writeFileSync(resolve(knowledgeDir, "index.json"), JSON.stringify({ entries: [] }), "utf-8");
  return knowledgeDir;
}

function dataOf(result: CLIResult): Record<string, unknown> {
  expect(result.ok).toBe(true);
  return (result as { ok: true; data: unknown }).data as Record<string, unknown>;
}

function warningsOf(result: CLIResult): unknown {
  return dataOf(result).warnings;
}

// A shallow body: a single short sentence well under the 120-char floor.
const SHALLOW_BODY = "A short note.";

// A rich body: multiple `##` sections with >120 chars of real prose content.
const RICH_BODY = [
  "## When to use",
  "Reach for this when you keep re-deriving the same threshold across multiple",
  "consumers and want a single source of truth so the values can never drift.",
  "",
  "## Shape",
  "Export the constant and the predicate from one pure module; every consumer",
  "imports it rather than redefining the magic number inline at each call site.",
].join("\n");

describe("knowledge create — shallow-body write guard", () => {
  it("shallow body → ok:true with a /shallow body/ warning, entry still persisted", async () => {
    await withTempDataDir(async (dir) => {
      const kdir = seedProject(dir, "wg-create");
      const result = await runCommand("knowledge create", [
        "wg-create",
        "Thin Create",
        "--kind=pattern",
        `--body=${SHALLOW_BODY}`,
      ]);
      expect(result.ok).toBe(true);
      const warnings = warningsOf(result) as string[];
      expect(Array.isArray(warnings)).toBe(true);
      expect(warnings.some((w) => /shallow body/.test(w))).toBe(true);
      // The warning does not block the write — the entry is actually persisted.
      expect(existsSync(resolve(kdir, "thin-create.meta.json"))).toBe(true);
      expect(existsSync(resolve(kdir, "thin-create.md"))).toBe(true);
    });
  });

  it("shallow body with --allow-thin → ok:true and NO warnings key", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "wg-create-allow");
      const result = await runCommand("knowledge create", [
        "wg-create-allow",
        "Thin Create Allowed",
        "--kind=pattern",
        `--body=${SHALLOW_BODY}`,
        "--allow-thin",
      ]);
      expect(result.ok).toBe(true);
      expect(dataOf(result).warnings).toBeUndefined();
    });
  });

  it("rich body → ok:true and no warnings", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "wg-create-rich");
      const result = await runCommand("knowledge create", [
        "wg-create-rich",
        "Rich Create",
        "--kind=pattern",
        `--body=${RICH_BODY}`,
      ]);
      expect(result.ok).toBe(true);
      expect(dataOf(result).warnings).toBeUndefined();
    });
  });
});

describe("knowledge upsert — shallow-body write guard", () => {
  it("shallow body (create path) → ok:true with /shallow body/ warning, persisted", async () => {
    await withTempDataDir(async (dir) => {
      const kdir = seedProject(dir, "wg-upsert");
      const result = await runCommand("knowledge upsert", [
        "wg-upsert",
        "Thin Upsert",
        "--kind=lesson",
        `--body=${SHALLOW_BODY}`,
      ]);
      expect(result.ok).toBe(true);
      const warnings = warningsOf(result) as string[];
      expect(Array.isArray(warnings)).toBe(true);
      expect(warnings.some((w) => /shallow body/.test(w))).toBe(true);
      expect(existsSync(resolve(kdir, "thin-upsert.meta.json"))).toBe(true);
    });
  });

  it("shallow body with --allow-thin → ok:true and NO warnings key", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "wg-upsert-allow");
      const result = await runCommand("knowledge upsert", [
        "wg-upsert-allow",
        "Thin Upsert Allowed",
        "--kind=lesson",
        `--body=${SHALLOW_BODY}`,
        "--allow-thin",
      ]);
      expect(result.ok).toBe(true);
      expect(dataOf(result).warnings).toBeUndefined();
    });
  });

  it("rich body → ok:true and no warnings", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "wg-upsert-rich");
      const result = await runCommand("knowledge upsert", [
        "wg-upsert-rich",
        "Rich Upsert",
        "--kind=lesson",
        `--body=${RICH_BODY}`,
      ]);
      expect(result.ok).toBe(true);
      expect(dataOf(result).warnings).toBeUndefined();
    });
  });

  it("shallow body on the UPDATE path → ok:true with /shallow body/ warning", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "wg-upsert-update");
      // Seed an existing entry (rich, no warning), then upsert a shallow body.
      await runCommand("knowledge upsert", [
        "wg-upsert-update",
        "Reupsert Target",
        "--kind=lesson",
        `--body=${RICH_BODY}`,
      ]);
      const result = await runCommand("knowledge upsert", [
        "wg-upsert-update",
        "Reupsert Target",
        "--kind=lesson",
        `--body=${SHALLOW_BODY}`,
      ]);
      expect(result.ok).toBe(true);
      expect(dataOf(result).created).toBe(false);
      const warnings = warningsOf(result) as string[];
      expect(warnings.some((w) => /shallow body/.test(w))).toBe(true);
    });
  });
});

describe("knowledge update-body — shallow-body write guard", () => {
  async function seedEntry(slug: string) {
    await runCommand("knowledge create", [
      slug,
      "Body Target",
      "--kind=gotcha",
      `--body=${RICH_BODY}`,
    ]);
  }

  it("shallow body → ok:true with /shallow body/ warning, body still persisted", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "wg-body");
      await seedEntry("wg-body");
      const result = await runCommand("knowledge update-body", [
        "wg-body",
        "body-target",
        `--body=${SHALLOW_BODY}`,
      ]);
      expect(result.ok).toBe(true);
      const warnings = warningsOf(result) as string[];
      expect(Array.isArray(warnings)).toBe(true);
      expect(warnings.some((w) => /shallow body/.test(w))).toBe(true);
      // The shallow body was written despite the warning.
      expect(dataOf(result).body).toBe(SHALLOW_BODY);
    });
  });

  it("shallow body with --allow-thin → ok:true and NO warnings key", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "wg-body-allow");
      await seedEntry("wg-body-allow");
      const result = await runCommand("knowledge update-body", [
        "wg-body-allow",
        "body-target",
        `--body=${SHALLOW_BODY}`,
        "--allow-thin",
      ]);
      expect(result.ok).toBe(true);
      expect(dataOf(result).warnings).toBeUndefined();
    });
  });

  it("rich body → ok:true and no warnings", async () => {
    await withTempDataDir(async (dir) => {
      seedProject(dir, "wg-body-rich");
      await seedEntry("wg-body-rich");
      const result = await runCommand("knowledge update-body", [
        "wg-body-rich",
        "body-target",
        `--body=${RICH_BODY}`,
      ]);
      expect(result.ok).toBe(true);
      expect(dataOf(result).warnings).toBeUndefined();
    });
  });
});
