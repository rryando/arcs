// ---------------------------------------------------------------------------
// Tests for task-store dependsOn field
// ---------------------------------------------------------------------------

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTask, updateTask } from "../src/utils/task-store.js";

const tempDirs: string[] = [];

function makeProjectDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "arcs-task-store-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("task-store: dependsOn field", () => {
  it("creates task without dependsOn — backward compat", async () => {
    const dir = makeProjectDir();
    const task = await createTask(dir, { title: "Task A" });
    expect(task.dependsOn).toBeUndefined();
  });

  it("creates task with empty dependsOn — stores no field", async () => {
    const dir = makeProjectDir();
    const task = await createTask(dir, { title: "Task A", dependsOn: [] });
    expect(task.dependsOn).toBeUndefined();
  });

  it("creates task with valid dependsOn", async () => {
    const dir = makeProjectDir();
    const dep = await createTask(dir, { title: "Dep Task" });
    const task = await createTask(dir, { title: "Dependent Task", dependsOn: [dep.normalizedId] });
    expect(task.dependsOn).toEqual([dep.normalizedId]);
  });

  it("rejects dependsOn with unknown task ID", async () => {
    const dir = makeProjectDir();
    await expect(
      createTask(dir, { title: "Task A", dependsOn: ["nonexistent-task"] }),
    ).rejects.toThrow("does not exist");
  });

  it("rejects dependsOn creating a direct cycle", async () => {
    const dir = makeProjectDir();
    const a = await createTask(dir, { title: "Task A" });
    const b = await createTask(dir, { title: "Task B", dependsOn: [a.normalizedId] });
    // Now try to make A depend on B — would create cycle
    await expect(
      updateTask(dir, { id: a.normalizedId, dependsOn: [b.normalizedId] }),
    ).rejects.toThrow("cycle detected");
  });

  it("rejects dependsOn creating indirect cycle", async () => {
    const dir = makeProjectDir();
    const a = await createTask(dir, { title: "Task A" });
    const b = await createTask(dir, { title: "Task B", dependsOn: [a.normalizedId] });
    const c = await createTask(dir, { title: "Task C", dependsOn: [b.normalizedId] });
    // a -> b -> c, now try a depends on c
    await expect(
      updateTask(dir, { id: a.normalizedId, dependsOn: [c.normalizedId] }),
    ).rejects.toThrow("cycle detected");
  });

  it("updates task dependsOn to valid value", async () => {
    const dir = makeProjectDir();
    const a = await createTask(dir, { title: "Task A" });
    const b = await createTask(dir, { title: "Task B" });
    const updated = await updateTask(dir, { id: b.normalizedId, dependsOn: [a.normalizedId] });
    expect(updated.dependsOn).toEqual([a.normalizedId]);
  });

  it("removes dependsOn by passing null", async () => {
    const dir = makeProjectDir();
    const a = await createTask(dir, { title: "Task A" });
    const b = await createTask(dir, { title: "Task B", dependsOn: [a.normalizedId] });
    expect(b.dependsOn).toEqual([a.normalizedId]);
    const updated = await updateTask(dir, { id: b.normalizedId, dependsOn: null });
    expect(updated.dependsOn).toBeUndefined();
  });

  it("removes dependsOn by passing empty array", async () => {
    const dir = makeProjectDir();
    const a = await createTask(dir, { title: "Task A" });
    const b = await createTask(dir, { title: "Task B", dependsOn: [a.normalizedId] });
    const updated = await updateTask(dir, { id: b.normalizedId, dependsOn: [] });
    expect(updated.dependsOn).toBeUndefined();
  });

  it("error message includes cycle path", async () => {
    const dir = makeProjectDir();
    const a = await createTask(dir, { title: "Task A" });
    const b = await createTask(dir, { title: "Task B", dependsOn: [a.normalizedId] });
    await expect(
      updateTask(dir, { id: a.normalizedId, dependsOn: [b.normalizedId] }),
    ).rejects.toThrow(/→/);
  });

  it("tasks without dependsOn field work as before — update other fields", async () => {
    const dir = makeProjectDir();
    const task = await createTask(dir, { title: "Task A" });
    const updated = await updateTask(dir, { id: task.normalizedId, status: "in_progress" });
    expect(updated.status).toBe("in_progress");
    expect(updated.dependsOn).toBeUndefined();
  });
});

describe("task-store: per-node diagram metadata fields", () => {
  it("creates task without metadata fields — backward compat", async () => {
    const dir = makeProjectDir();
    const task = await createTask(dir, { title: "Task A" });
    expect(task.scope).toBeUndefined();
    expect(task.acceptance).toBeUndefined();
    expect(task.verify).toBeUndefined();
    expect(task.skill).toBeUndefined();
    expect(task.sourceFiles).toBeUndefined();
  });

  it("round-trips all 5 metadata fields on create", async () => {
    const dir = makeProjectDir();
    const task = await createTask(dir, {
      title: "Round Trip",
      scope: "src/foo.ts",
      acceptance: "passes test X",
      verify: "vitest run foo.test.ts",
      skill: "quick-dev",
      sourceFiles: [{ path: "src/foo.ts", anchor: "line-42" }],
    });
    expect(task.scope).toBe("src/foo.ts");
    expect(task.acceptance).toBe("passes test X");
    expect(task.verify).toBe("vitest run foo.test.ts");
    expect(task.skill).toBe("quick-dev");
    expect(task.sourceFiles).toEqual([{ path: "src/foo.ts", anchor: "line-42" }]);
  });

  it("round-trips fields after re-read from index", async () => {
    const dir = makeProjectDir();
    const created = await createTask(dir, {
      title: "Persisted Task",
      scope: "src/bar.ts",
      acceptance: "bar works",
      verify: "npm test",
      skill: "code-agent",
      sourceFiles: [{ path: "src/bar.ts" }],
    });
    // Force a fresh read by listing tasks (hits the JSON index)
    const { listTasks } = await import("../src/utils/task-store.js");
    const all = await listTasks(dir);
    const fetched = all.find((t) => t.normalizedId === created.normalizedId);
    expect(fetched).toBeDefined();
    expect(fetched?.scope).toBe("src/bar.ts");
    expect(fetched?.acceptance).toBe("bar works");
    expect(fetched?.verify).toBe("npm test");
    expect(fetched?.skill).toBe("code-agent");
    expect(fetched?.sourceFiles).toEqual([{ path: "src/bar.ts" }]);
  });

  it("update sets new metadata fields", async () => {
    const dir = makeProjectDir();
    const task = await createTask(dir, { title: "Task A" });
    const updated = await updateTask(dir, {
      id: task.normalizedId,
      scope: "src/x.ts",
      acceptance: "x is good",
      verify: "x test",
      skill: "tdd",
    });
    expect(updated.scope).toBe("src/x.ts");
    expect(updated.acceptance).toBe("x is good");
    expect(updated.verify).toBe("x test");
    expect(updated.skill).toBe("tdd");
  });

  it("update with null clears metadata fields", async () => {
    const dir = makeProjectDir();
    const task = await createTask(dir, {
      title: "Task A",
      scope: "src/foo.ts",
      acceptance: "ok",
      verify: "test",
      skill: "quick-dev",
    });
    const cleared = await updateTask(dir, {
      id: task.normalizedId,
      scope: null,
      acceptance: null,
      verify: null,
      skill: null,
    });
    expect(cleared.scope).toBeUndefined();
    expect(cleared.acceptance).toBeUndefined();
    expect(cleared.verify).toBeUndefined();
    expect(cleared.skill).toBeUndefined();
  });

  it("update with empty sourceFiles array clears the field", async () => {
    const dir = makeProjectDir();
    const task = await createTask(dir, {
      title: "Task A",
      sourceFiles: [{ path: "src/foo.ts" }],
    });
    const cleared = await updateTask(dir, { id: task.normalizedId, sourceFiles: [] });
    expect(cleared.sourceFiles).toBeUndefined();
  });

  it("partial update preserves untouched metadata fields", async () => {
    const dir = makeProjectDir();
    const task = await createTask(dir, {
      title: "Task A",
      scope: "src/foo.ts",
      acceptance: "passes",
      verify: "test",
      skill: "quick-dev",
    });
    // Only update scope; other fields must remain.
    const updated = await updateTask(dir, { id: task.normalizedId, scope: "src/bar.ts" });
    expect(updated.scope).toBe("src/bar.ts");
    expect(updated.acceptance).toBe("passes");
    expect(updated.verify).toBe("test");
    expect(updated.skill).toBe("quick-dev");
  });
});
