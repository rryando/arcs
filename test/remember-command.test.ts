import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleDagCommand } from "../src/cli/dag-commands.js";

function createTempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "arcs-remember-test-"));
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      version: "1.0",
      projects: [{ id: "test-proj", name: "Test Project", status: "active", dependsOn: [] }],
    }),
  );
  const projDir = join(dir, "projects", "test-proj");
  mkdirSync(projDir, { recursive: true });
  writeFileSync(
    join(projDir, "meta.json"),
    JSON.stringify({
      id: "test-proj",
      name: "Test Project",
      description: "A test project",
      createdAt: "2025-01-01T00:00:00.000Z",
      workspacePaths: ["/tmp/test-workspace"],
    }),
  );
  const knowledgeDir = join(projDir, "knowledge");
  mkdirSync(knowledgeDir, { recursive: true });
  writeFileSync(join(knowledgeDir, "index.json"), JSON.stringify({ entries: [] }));
  return dir;
}

let dataDir: string;
const stdout: string[] = [];
const stderr: string[] = [];

beforeEach(() => {
  dataDir = createTempDataDir();
  process.env.ARCS_DATA_DIR = dataDir;
  stdout.length = 0;
  stderr.length = 0;
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  delete process.env.ARCS_DATA_DIR;
  vi.restoreAllMocks();
});

describe("arcs remember", () => {
  it("creates a gotcha entry for 'never' keywords", async () => {
    await handleDagCommand("remember", ["test-proj", "Never use MCP again", "--json"]);
    const parsed = JSON.parse(stdout[0]);
    expect(parsed.kind).toBe("gotcha");
    expect(parsed.summary).toBe("Never use MCP again");
  });

  it("creates a gotcha for 'don't' keyword", async () => {
    await handleDagCommand("remember", ["test-proj", "don't mutate state directly", "--json"]);
    const parsed = JSON.parse(stdout[0]);
    expect(parsed.kind).toBe("gotcha");
  });

  it("creates a decision entry for 'decided' keyword", async () => {
    await handleDagCommand("remember", ["test-proj", "We decided to go CLI-only", "--json"]);
    const parsed = JSON.parse(stdout[0]);
    expect(parsed.kind).toBe("decision");
  });

  it("defaults to lesson for unrecognized text", async () => {
    await handleDagCommand("remember", ["test-proj", "Some random insight", "--json"]);
    const parsed = JSON.parse(stdout[0]);
    expect(parsed.kind).toBe("lesson");
  });

  it("creates a pattern entry for 'pattern' keyword", async () => {
    await handleDagCommand("remember", [
      "test-proj",
      "Use this pattern for all commands",
      "--json",
    ]);
    const parsed = JSON.parse(stdout[0]);
    expect(parsed.kind).toBe("pattern");
  });

  it("auto-generates title from short text", async () => {
    await handleDagCommand("remember", ["test-proj", "Short insight", "--json"]);
    const parsed = JSON.parse(stdout[0]);
    expect(parsed.title).toBe("Short insight");
  });

  it("truncates long text to title with ellipsis", async () => {
    const longText =
      "This is a very long insight that definitely exceeds the fifty character limit for titles";
    await handleDagCommand("remember", ["test-proj", longText, "--json"]);
    const parsed = JSON.parse(stdout[0]);
    expect(parsed.title).toMatch(/\.\.\.$/);
    expect(parsed.title.length).toBeLessThanOrEqual(53); // 50 + "..."
    expect(parsed.summary).toBe(longText);
  });

  it("returns id in response", async () => {
    await handleDagCommand("remember", ["test-proj", "A simple lesson", "--json"]);
    const parsed = JSON.parse(stdout[0]);
    expect(parsed.id).toBeTruthy();
  });

  it("errors on nonexistent project", async () => {
    await handleDagCommand("remember", ["nonexistent", "some insight", "--json"]);
    const parsed = JSON.parse(stderr[0]);
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain("nonexistent");
  });
});

describe("arcs remember --code", () => {
  function rememberKnowledgeDir(): string {
    return join(dataDir, "projects", "test-proj", "knowledge");
  }

  it("captures a deterministic chunk from the project workspace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "arcs-remember-ws-"));
    mkdirSync(join(workspace, "src"), { recursive: true });
    const snippet = "const a = 1;\nconst b = 2;\nconst c = 3;";
    writeFileSync(join(workspace, "src", "x.ts"), `${snippet}\n`, "utf-8");
    writeFileSync(
      join(dataDir, "projects", "test-proj", "meta.json"),
      JSON.stringify({
        id: "test-proj",
        name: "Test Project",
        workspacePaths: [workspace],
      }),
      "utf-8",
    );

    await handleDagCommand("remember", [
      "test-proj",
      "Code linked lesson",
      "--code=src/x.ts:1-3",
      "--json",
    ]);
    const parsed = JSON.parse(stdout[0]);
    expect(parsed.id).toBeTruthy();
    const meta = JSON.parse(
      readFileSync(join(rememberKnowledgeDir(), `${parsed.id}.meta.json`), "utf-8"),
    );
    expect(meta.codeChunks).toHaveLength(1);
    expect(meta.codeChunks[0].path).toBe("src/x.ts");
    expect(meta.codeChunks[0].snippet).toBe(snippet);
  });

  it("rejects a malformed --code and creates nothing", async () => {
    await handleDagCommand("remember", ["test-proj", "Bad code ref", "--code=src/x.ts", "--json"]);
    const parsed = JSON.parse(stderr[0]);
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain("src/x.ts");
    expect(existsSync(join(rememberKnowledgeDir(), "bad-code-ref.meta.json"))).toBe(false);
  });
});

describe("arcs remember --code resolves a relative ref against a git-work-tree CWD", () => {
  it("captures from the CWD tree when the registered workspace lacks the file (exact repro)", async () => {
    // The CWD is a distinct git work tree that HAS the file; the project's
    // workspacePaths[0] points elsewhere and does not.
    const cwdRepo = mkdtempSync(join(tmpdir(), "arcs-remember-cwd-"));
    execSync("git init", { cwd: cwdRepo, stdio: "pipe" });
    mkdirSync(join(cwdRepo, "src", "utils"), { recursive: true });
    const snippet = "line 124\nline 125\nline 126";
    writeFileSync(join(cwdRepo, "src", "utils", "run-report.ts"), `${snippet}\n`, "utf-8");

    const otherWs = mkdtempSync(join(tmpdir(), "arcs-remember-ws-"));
    writeFileSync(
      join(dataDir, "projects", "test-proj", "meta.json"),
      JSON.stringify({ id: "test-proj", name: "Test Project", workspacePaths: [otherWs] }),
      "utf-8",
    );

    const previous = process.cwd();
    process.chdir(cwdRepo);
    try {
      await handleDagCommand("remember", [
        "test-proj",
        "diff.mnemonicPrefix probe",
        "--code=src/utils/run-report.ts:1-3",
        "--json",
      ]);
    } finally {
      process.chdir(previous);
    }

    const parsed = JSON.parse(stdout[0]);
    expect(parsed.id).toBeTruthy();
    const meta = JSON.parse(
      readFileSync(
        join(dataDir, "projects", "test-proj", "knowledge", `${parsed.id}.meta.json`),
        "utf-8",
      ),
    );
    expect(meta.codeChunks).toHaveLength(1);
    expect(meta.codeChunks[0].path).toBe("src/utils/run-report.ts");
    expect(meta.codeChunks[0].snippet).toBe(snippet);
  });
});
