import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { listReceipts, readReceipt, writeReceipt } from "../src/utils/report-store.js";
import {
  captureReceipt,
  commitUrl,
  getRemoteUrl,
  RUN_REPORT_DIFF_MAX_BYTES,
  RUN_REPORT_DIFF_MAX_LINES,
} from "../src/utils/run-report.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** One git call, argv only (never a shell), throwing on failure. */
function git(dir: string, args: string[]): string {
  const proc = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (proc.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr ?? proc.error}`);
  }
  return (proc.stdout ?? "").trim();
}

/**
 * A real temp repo with a LOCAL identity so commits succeed in CI-like
 * environments that have no global git config.
 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "arcs-run-report-repo-"));
  tempDirs.push(dir);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Receipt Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

function commit(dir: string, message: string): string {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function write(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content);
}

describe("commitUrl", () => {
  const sha = "abc123def456";

  it("builds a GitHub web URL from ssh, https, and .git-less remotes", () => {
    const expected = `https://github.com/owner/repo/commit/${sha}`;
    expect(commitUrl("git@github.com:owner/repo.git", sha)).toBe(expected);
    expect(commitUrl("https://github.com/owner/repo.git", sha)).toBe(expected);
    expect(commitUrl("https://github.com/owner/repo", sha)).toBe(expected);
    expect(commitUrl("ssh://git@github.com/owner/repo.git", sha)).toBe(expected);
  });

  it("preserves nested GitLab group paths and uses /-/commit/", () => {
    expect(commitUrl("git@gitlab.com:group/sub/repo.git", sha)).toBe(
      `https://gitlab.com/group/sub/repo/-/commit/${sha}`,
    );
    expect(commitUrl("https://gitlab.com/group/sub/repo.git", sha)).toBe(
      `https://gitlab.com/group/sub/repo/-/commit/${sha}`,
    );
  });

  it("preserves a non-standard port", () => {
    expect(commitUrl("https://gitlab.example.com:8443/group/sub/repo.git", sha)).toBe(
      `https://gitlab.example.com:8443/group/sub/repo/-/commit/${sha}`,
    );
  });

  it("uses /commits/ for Bitbucket", () => {
    expect(commitUrl("git@bitbucket.org:owner/repo.git", sha)).toBe(
      `https://bitbucket.org/owner/repo/commits/${sha}`,
    );
  });

  it("returns null for null, empty, and unknown hosts", () => {
    expect(commitUrl(null, sha)).toBeNull();
    expect(commitUrl(undefined, sha)).toBeNull();
    expect(commitUrl("", sha)).toBeNull();
    expect(commitUrl("   ", sha)).toBeNull();
    expect(commitUrl("git@example.com:owner/repo.git", sha)).toBeNull();
    expect(commitUrl("https://example.com/owner/repo.git", sha)).toBeNull();
  });
});

describe("getRemoteUrl", () => {
  it("returns the origin URL, and null without a remote", async () => {
    const withRemote = makeRepo();
    write(withRemote, "a.txt", "one\n");
    commit(withRemote, "init");
    git(withRemote, ["remote", "add", "origin", "git@github.com:owner/repo.git"]);
    await expect(getRemoteUrl(withRemote)).resolves.toBe("git@github.com:owner/repo.git");

    const withoutRemote = makeRepo();
    write(withoutRemote, "a.txt", "one\n");
    commit(withoutRemote, "init");
    await expect(getRemoteUrl(withoutRemote)).resolves.toBeNull();
  });

  it("returns null outside a git repo", async () => {
    const plain = mkdtempSync(join(tmpdir(), "arcs-run-report-plain-"));
    tempDirs.push(plain);
    await expect(getRemoteUrl(plain)).resolves.toBeNull();
  });
});

describe("captureReceipt", () => {
  it("captures base/head shas, branch, file count, line stats, and a real diff", async () => {
    const dir = makeRepo();
    write(dir, "a.txt", "one\n");
    const baseSha = commit(dir, "base");

    write(dir, "a.txt", "two\nthree\n");
    write(dir, "b.txt", "x\ny\nz\n");
    const headSha = commit(dir, "head");
    const branch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);

    const result = await captureReceipt(dir, { baseRef: baseSha });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const receipt = result.report;
    expect(receipt.baseSha).toBe(baseSha);
    expect(receipt.headSha).toBe(headSha);
    expect(receipt.branch).toBe(branch);
    expect(receipt.filesChanged).toBe(2);
    expect(receipt.insertions).toBe(5);
    expect(receipt.deletions).toBe(1);
    expect(receipt.diff).not.toBe("");
    expect(receipt.diff).toContain("@@");
    expect(receipt.diffTruncated).toBe(false);
    expect(receipt.repoRoot).toBeTruthy();
    expect(Date.parse(receipt.capturedAt)).not.toBeNaN();
  });

  it("resolves url from a github ssh origin and null without a remote", async () => {
    const withRemote = makeRepo();
    write(withRemote, "a.txt", "one\n");
    const base = commit(withRemote, "base");
    write(withRemote, "a.txt", "two\n");
    const head = commit(withRemote, "head");
    git(withRemote, ["remote", "add", "origin", "git@github.com:owner/repo.git"]);

    const remoteResult = await captureReceipt(withRemote, { baseRef: base });
    expect(remoteResult.ok).toBe(true);
    if (remoteResult.ok) {
      expect(remoteResult.report.remoteUrl).toBe("git@github.com:owner/repo.git");
      expect(remoteResult.report.url).toBe(`https://github.com/owner/repo/commit/${head}`);
    }

    const plain = makeRepo();
    write(plain, "a.txt", "one\n");
    const plainBase = commit(plain, "base");
    write(plain, "a.txt", "two\n");
    commit(plain, "head");

    const noRemote = await captureReceipt(plain, { baseRef: plainBase });
    expect(noRemote.ok).toBe(true);
    if (noRemote.ok) {
      expect(noRemote.report.remoteUrl).toBeNull();
      expect(noRemote.report.url).toBeNull();
    }
  });

  it("fails closed outside a git repo without throwing", async () => {
    const plain = mkdtempSync(join(tmpdir(), "arcs-run-report-nogit-"));
    tempDirs.push(plain);
    const result = await captureReceipt(plain, { baseRef: "HEAD~1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(typeof result.reason).toBe("string");
  });

  it("fails closed on an unresolvable base ref", async () => {
    const dir = makeRepo();
    write(dir, "a.txt", "one\n");
    commit(dir, "base");
    const result = await captureReceipt(dir, { baseRef: "no-such-ref-exists" });
    expect(result.ok).toBe(false);
  });

  it("fails closed when git exceeds the timeout and never hangs", async () => {
    const shimDir = mkdtempSync(join(tmpdir(), "arcs-run-report-shim-"));
    tempDirs.push(shimDir);
    const shim = join(shimDir, "git");
    // `exec` replaces the shell so SIGKILL reaches the sleeping process itself.
    writeFileSync(shim, "#!/bin/sh\nexec sleep 600\n");
    chmodSync(shim, 0o755);

    const priorPath = process.env.PATH;
    process.env.PATH = `${shimDir}${delimiter}${priorPath ?? ""}`;
    try {
      const started = Date.now();
      const result = await captureReceipt(shimDir, { timeoutMs: 150 });
      expect(Date.now() - started).toBeLessThan(3000);
      expect(result.ok).toBe(false);
    } finally {
      process.env.PATH = priorPath;
    }
  });

  it("caps an oversized diff and flags truncation", async () => {
    const dir = makeRepo();
    write(dir, "big.txt", "start\n");
    const base = commit(dir, "base");
    const body = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
    write(dir, "big.txt", `${body}\n`);
    commit(dir, "big");

    const result = await captureReceipt(dir, { baseRef: base });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.diffTruncated).toBe(true);
    expect(result.report.diff.split("\n").length).toBeLessThanOrEqual(RUN_REPORT_DIFF_MAX_LINES);
    expect(Buffer.byteLength(result.report.diff, "utf-8")).toBeLessThanOrEqual(
      RUN_REPORT_DIFF_MAX_BYTES,
    );
  });
});

describe("report-store", () => {
  async function sampleReceipt(dataRoot: string, slug: string) {
    const dir = makeRepo();
    write(dir, "a.txt", "one\n");
    const base = commit(dir, "base");
    write(dir, "a.txt", "two\n");
    commit(dir, "head");
    const result = await captureReceipt(dir, { baseRef: base, taskId: "task-1" });
    if (!result.ok) throw new Error("capture failed");
    return { receipt: result.report, dataRoot, slug };
  }

  it("writes both sidecar files and returns a pointer at them", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "arcs-run-report-data-"));
    tempDirs.push(dataRoot);
    const { receipt } = await sampleReceipt(dataRoot, "demo");

    const ref = writeReceipt(dataRoot, "demo", receipt);
    expect(ref.commit).toBe(receipt.headSha);
    expect(ref.baseRef).toBe(receipt.baseRef);
    expect(ref.filesChanged).toBe(receipt.filesChanged);
    expect(ref.truncated).toBe(false);

    expect(existsSync(join(dataRoot, ref.reportFile))).toBe(true);
    expect(ref.diffFile).toBeDefined();
    expect(existsSync(join(dataRoot, ref.diffFile as string))).toBe(true);
    expect(readFileSync(join(dataRoot, ref.diffFile as string), "utf-8")).toBe(receipt.diff);
  });

  it("round-trips through readReceipt and lists written receipts", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "arcs-run-report-data-"));
    tempDirs.push(dataRoot);
    const { receipt } = await sampleReceipt(dataRoot, "demo");
    writeReceipt(dataRoot, "demo", receipt);

    const read = readReceipt(dataRoot, "demo", "task-1");
    expect(read).not.toBeNull();
    expect(read?.headSha).toBe(receipt.headSha);
    expect(read?.diff).toBe(receipt.diff);

    expect(listReceipts(dataRoot, "demo")).toHaveLength(1);
  });

  it("returns null for a missing receipt rather than throwing", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "arcs-run-report-data-"));
    tempDirs.push(dataRoot);
    expect(readReceipt(dataRoot, "demo", "missing")).toBeNull();
    expect(listReceipts(dataRoot, "demo")).toEqual([]);
  });
});

describe("deterministic offline contract", () => {
  const sources = {
    "run-report": readFileSync(join(REPO_ROOT, "src", "utils", "run-report.ts"), "utf-8"),
    "report-store": readFileSync(join(REPO_ROOT, "src", "utils", "report-store.ts"), "utf-8"),
  };

  for (const [name, source] of Object.entries(sources)) {
    it(`${name} imports no network modules and never uses fetch`, () => {
      expect(source).not.toMatch(/from\s+["']node:(?:http|https|http2|net|dns)["']/);
      expect(source).not.toMatch(/require\(["'](?:node:)?(?:http|https|net|dns)["']\)/);
      expect(source).not.toMatch(/\bfetch\s*\(/);
    });

    it(`${name} invokes git with an argv array, never a shell string`, () => {
      expect(source).not.toMatch(/shell\s*:\s*true/);
      expect(source).not.toMatch(/\bexecSync\s*\(\s*["'`]/);
      expect(source).not.toMatch(/\bexec\s*\(\s*["'`]/);
    });
  }

  it("run-report drives git through spawnSync with argv", () => {
    expect(sources["run-report"]).toMatch(/spawnSync\(\s*["']git["']/);
  });
});
