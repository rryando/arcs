/**
 * Unit tests for the worktree registry store (src/utils/worktree-store.ts).
 *
 * Covers:
 * - upsertWorktreeEntry: insert, then update preserving createdAt while
 *   refreshing path/branch/baseCommit
 * - removeWorktreeEntry: true when a row was removed, false otherwise
 * - readWorktreeRegistry: fail-open [] on missing/corrupt files; malformed
 *   rows skipped while valid rows survive
 * - findPathCollisions: cross-plan same-path and duplicate same-plan rows;
 *   [] for healthy registries
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findPathCollisions,
  readWorktreeRegistry,
  removeWorktreeEntry,
  upsertWorktreeEntry,
  WORKTREES_FILE,
  type WorktreeEntry,
} from "../src/utils/worktree-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProjectDir(): { projectDir: string; cleanup: () => void } {
  const projectDir = mkdtempSync(resolve(tmpdir(), "arcs-wt-store-"));
  return {
    projectDir,
    cleanup: () => rmSync(projectDir, { recursive: true, force: true }),
  };
}

function entry(partial: { planId: string; path: string; branch?: string }): WorktreeEntry {
  return {
    planId: partial.planId,
    path: partial.path,
    branch: partial.branch ?? `arcs/${partial.planId}`,
    createdAt: "2025-01-01T00:00:00Z",
  };
}

// ---------------------------------------------------------------------------
// upsertWorktreeEntry
// ---------------------------------------------------------------------------

describe("upsertWorktreeEntry", () => {
  let projectDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ projectDir, cleanup } = makeProjectDir());
  });

  afterEach(() => cleanup());

  it("inserts a new row keyed by normalized plan id", async () => {
    const inserted = await upsertWorktreeEntry(projectDir, {
      planId: "Plan Alpha!",
      path: "/tmp/wt-a",
      branch: "arcs/plan-alpha",
      baseCommit: "aaa111",
    });

    expect(inserted.planId).toBe("plan-alpha");
    expect(inserted.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const registry = await readWorktreeRegistry(projectDir);
    expect(registry).toHaveLength(1);
    expect(registry[0]).toMatchObject({
      planId: "plan-alpha",
      path: "/tmp/wt-a",
      branch: "arcs/plan-alpha",
      baseCommit: "aaa111",
    });
  });

  it("update preserves createdAt and refreshes path/branch/baseCommit", async () => {
    const first = await upsertWorktreeEntry(projectDir, {
      planId: "plan-a",
      path: "/tmp/wt-old",
      branch: "arcs/plan-a",
      baseCommit: "bbb222",
    });

    const second = await upsertWorktreeEntry(projectDir, {
      planId: "plan-a",
      path: "/tmp/wt-new",
      branch: "arcs/plan-a-v2",
    });

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.path).toBe("/tmp/wt-new");
    expect(second.branch).toBe("arcs/plan-a-v2");
    expect(second.baseCommit).toBeUndefined();

    const rows = await readWorktreeRegistry(projectDir);
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe("/tmp/wt-new");
    expect(rows[0].createdAt).toBe(first.createdAt);
    expect("baseCommit" in rows[0]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// removeWorktreeEntry
// ---------------------------------------------------------------------------

describe("removeWorktreeEntry", () => {
  let projectDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ projectDir, cleanup } = makeProjectDir());
  });

  afterEach(() => cleanup());

  it("returns true once a row exists, then false afterwards", async () => {
    await upsertWorktreeEntry(projectDir, {
      planId: "plan-a",
      path: "/tmp/wt-a",
      branch: "arcs/plan-a",
    });

    expect(await removeWorktreeEntry(projectDir, "plan-a")).toBe(true);
    expect(await removeWorktreeEntry(projectDir, "plan-a")).toBe(false);
    expect(await readWorktreeRegistry(projectDir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// readWorktreeRegistry — fail-open reads
// ---------------------------------------------------------------------------

describe("readWorktreeRegistry", () => {
  let projectDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ projectDir, cleanup } = makeProjectDir());
  });

  afterEach(() => cleanup());

  it("returns [] when the registry file does not exist", async () => {
    expect(await readWorktreeRegistry(projectDir)).toEqual([]);
  });

  it("returns [] when the registry file is corrupt JSON", async () => {
    writeFileSync(join(projectDir, WORKTREES_FILE), "{ this is not json", "utf-8");
    expect(await readWorktreeRegistry(projectDir)).toEqual([]);
  });

  it("returns [] when worktrees is not an array", async () => {
    writeFileSync(
      join(projectDir, WORKTREES_FILE),
      JSON.stringify({ worktrees: "all of them" }),
      "utf-8",
    );
    expect(await readWorktreeRegistry(projectDir)).toEqual([]);
  });

  it("skips malformed rows while valid rows survive", async () => {
    const validA = entry({ planId: "plan-a", path: "/tmp/wt-a", branch: "arcs/plan-a" });
    const validB = {
      planId: "plan-b",
      path: "/tmp/wt-b",
      branch: "arcs/plan-b",
    }; // no createdAt → sanitized to ""
    writeFileSync(
      join(projectDir, WORKTREES_FILE),
      JSON.stringify({
        worktrees: [
          null,
          "a string row",
          42,
          {},
          { planId: "", path: "/tmp/x", branch: "b" },
          { planId: "x", path: "", branch: "b" },
          { planId: "x", path: "/tmp/x", branch: "" },
          validA,
          validB,
        ],
      }),
      "utf-8",
    );

    const registry = await readWorktreeRegistry(projectDir);

    expect(registry).toHaveLength(2);
    expect(registry[0]).toEqual(validA);
    expect(registry[1]).toEqual({ ...validB, createdAt: "" });
  });
});

// ---------------------------------------------------------------------------
// findPathCollisions
// ---------------------------------------------------------------------------

describe("findPathCollisions", () => {
  it("returns [] for a healthy registry", () => {
    const collisions = findPathCollisions([
      entry({ planId: "plan-a", path: "/x/wt-a", branch: "arcs/plan-a" }),
      entry({ planId: "plan-b", path: "/x/wt-b", branch: "arcs/plan-b" }),
    ]);
    expect(collisions).toEqual([]);
  });

  it("detects cross-plan rows claiming the same resolved path", () => {
    const collisions = findPathCollisions([
      entry({ planId: "plan-b", path: "/x/nested/wt" }),
      entry({ planId: "plan-a", path: "/x/./nested/wt" }), // different spelling, same path
    ]);

    expect(collisions).toHaveLength(1);
    expect(collisions[0].path).toBe(resolve("/x/nested/wt"));
    expect(collisions[0].planIds).toEqual(["plan-a", "plan-b"]);
  });

  it("detects duplicate rows for a single plan", () => {
    const collisions = findPathCollisions([
      entry({ planId: "plan-a", path: "/x/wt-a", branch: "arcs/plan-a" }),
      entry({ planId: "plan-a", path: "/x/wt-a", branch: "arcs/plan-a" }),
    ]);

    expect(collisions).toHaveLength(1);
    expect(collisions[0].planIds).toEqual(["plan-a"]);
  });
});
