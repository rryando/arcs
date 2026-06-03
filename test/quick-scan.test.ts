import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { quickScan } from "../src/utils/quick-scan.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "arcs-quick-scan-test-"));
}

function initGitRepo(dir: string): void {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email 'test@test.com'", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name 'Test'", { cwd: dir, stdio: "pipe" });
}

function addCommit(dir: string, message: string, file = "file.ts", content = "// hi\n"): void {
  writeFileSync(join(dir, file), content);
  execSync(`git add ${file}`, { cwd: dir, stdio: "pipe" });
  execSync(`git commit -m "${message}"`, { cwd: dir, stdio: "pipe" });
}

describe("quickScan", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    // cleanup is implicit via OS tmp cleanup
  });

  it("returns empty result for non-existent path", () => {
    const result = quickScan("/nonexistent/path/that/does/not/exist");
    expect(result.recentBranches).toEqual([]);
    expect(result.recentCommitTopics).toEqual([]);
    expect(result.todos).toEqual([]);
    expect(result.suggestedTasks).toEqual([]);
  });

  it("returns empty git fields for non-git directory", () => {
    const result = quickScan(tmpDir);
    expect(result.recentBranches).toEqual([]);
    expect(result.recentCommitTopics).toEqual([]);
    // todos may or may not be empty, but no error
    expect(Array.isArray(result.todos)).toBe(true);
    expect(Array.isArray(result.suggestedTasks)).toBe(true);
  });

  it("extracts recent branches from a git repo", () => {
    initGitRepo(tmpDir);
    addCommit(tmpDir, "Initial commit");

    // Capture the default branch name (modern git → "main", older → "master").
    const defaultBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: tmpDir })
      .toString()
      .trim();

    // Create a feature branch
    execSync("git checkout -b feat/add-login", { cwd: tmpDir, stdio: "pipe" });
    addCommit(tmpDir, "feat: add login page", "login.ts");

    // Go back to the default branch (it already exists from `git init`)
    execSync(`git checkout ${defaultBranch}`, { cwd: tmpDir, stdio: "pipe" });

    const result = quickScan(tmpDir);
    // feat/add-login should be in branches (main is excluded)
    expect(result.recentBranches).toContain("feat/add-login");
    expect(result.recentBranches).not.toContain("main");
    expect(result.recentBranches).not.toContain("master");
  });

  it("extracts commit topics from git log", () => {
    initGitRepo(tmpDir);
    addCommit(tmpDir, "feat: add user authentication", "auth.ts");
    addCommit(tmpDir, "fix: resolve login bug", "auth2.ts");

    const result = quickScan(tmpDir);
    expect(result.recentCommitTopics.length).toBeGreaterThan(0);
    // Topics should contain relevant prefixes
    const allTopics = result.recentCommitTopics.join(" ");
    expect(allTopics).toMatch(/feat|fix|add|resolve/i);
  });

  it("extracts TODOs from TypeScript files", () => {
    // Create a TS file with a TODO
    writeFileSync(
      join(tmpDir, "example.ts"),
      `// Some code\nfunction foo() {\n  // TODO: implement this\n  return null;\n}\n`,
    );

    const result = quickScan(tmpDir);
    expect(result.todos.length).toBeGreaterThan(0);
    const todo = result.todos[0];
    expect(todo.file).toBe("example.ts");
    expect(todo.line).toBe(3);
    expect(todo.text).toMatch(/implement this/i);
  });

  it("extracts FIXME from source files", () => {
    writeFileSync(
      join(tmpDir, "code.ts"),
      `export function x() {\n  // FIXME: this is broken\n  return 1;\n}\n`,
    );

    const result = quickScan(tmpDir);
    expect(result.todos.some((t) => t.text.match(/broken/i))).toBe(true);
  });

  it("skips node_modules in TODO scan", () => {
    mkdirSync(join(tmpDir, "node_modules", "some-pkg"), { recursive: true });
    writeFileSync(
      join(tmpDir, "node_modules", "some-pkg", "index.ts"),
      "// TODO: this should be excluded\n",
    );

    const result = quickScan(tmpDir);
    const fromNodeModules = result.todos.filter((t) => t.file.startsWith("node_modules"));
    expect(fromNodeModules).toHaveLength(0);
  });

  it("generates suggested tasks from feature branches", () => {
    initGitRepo(tmpDir);
    addCommit(tmpDir, "Initial commit");
    execSync("git checkout -b feat/user-dashboard", { cwd: tmpDir, stdio: "pipe" });
    addCommit(tmpDir, "wip: dashboard", "dash.ts");
    execSync("git checkout -b fix/broken-api", { cwd: tmpDir, stdio: "pipe" });
    addCommit(tmpDir, "fix broken api", "api.ts");
    execSync("git checkout -b main2", { cwd: tmpDir, stdio: "pipe" });

    const result = quickScan(tmpDir);
    expect(result.suggestedTasks.length).toBeGreaterThan(0);
    // Should humanize branch names
    const titles = result.suggestedTasks.join(" ");
    expect(titles).toMatch(/Dashboard|Api|dashboard|api/i);
  });

  it("caps suggested tasks at 5", () => {
    initGitRepo(tmpDir);
    addCommit(tmpDir, "Initial commit");

    // Create 6 feature branches
    for (let i = 1; i <= 6; i++) {
      execSync(`git checkout -b feat/feature-${i}`, { cwd: tmpDir, stdio: "pipe" });
      addCommit(tmpDir, `feat: feature ${i}`, `f${i}.ts`);
    }

    const result = quickScan(tmpDir);
    expect(result.suggestedTasks.length).toBeLessThanOrEqual(5);
  });

  it("completes within 5 seconds", async () => {
    const start = Date.now();
    quickScan(tmpDir);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });
});
