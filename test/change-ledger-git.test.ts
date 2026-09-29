// ---------------------------------------------------------------------------
// Tests for the argv/timed git helpers that feed the change ledger
// (src/utils/git.ts): resolve/list/isAncestor, numstat + hunk headers,
// patch-id, and worktree diffstat including untracked files AND directories.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getCommitChanges,
  getCommitPatch,
  getWorktreeDiffstat,
  isAncestor,
  listCommits,
  resolveCommit,
} from "../src/utils/git.js";

const SHA_RE = /^[a-f0-9]{40}$/;

let repo: string;

function git(cwd: string, args: string[]): string {
  const proc = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  if (proc.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
  return (proc.stdout ?? "").trim();
}

function initRepo(dir: string): void {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Git Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}

function commitAll(dir: string, message: string): string {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "arcs-git-ledger-"));
  initRepo(repo);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("git ledger helpers — revision resolution", () => {
  it("resolves a revision to its full sha and rejects ranges/unknown refs", () => {
    writeFileSync(join(repo, "a.txt"), "one\n");
    const head = commitAll(repo, "base");

    expect(resolveCommit(repo, "HEAD")).toBe(head);
    expect(head).toMatch(SHA_RE);
    expect(resolveCommit(repo, "no-such-ref")).toBeNull();
    expect(resolveCommit(repo, "HEAD~2")).toBeNull();
    expect(resolveCommit(repo, "HEAD..HEAD")).toBeNull();
  });

  it("lists a range oldest-first and tests ancestry", () => {
    writeFileSync(join(repo, "a.txt"), "one\n");
    const base = commitAll(repo, "base");
    writeFileSync(join(repo, "b.txt"), "two\n");
    const second = commitAll(repo, "second");
    writeFileSync(join(repo, "c.txt"), "three\n");
    const third = commitAll(repo, "third");

    expect(listCommits(repo, `${base}..HEAD`)).toEqual([second, third]);
    expect(listCommits(repo, "not a range")).toEqual([]);

    expect(isAncestor(repo, base)).toBe(true);
    expect(isAncestor(repo, third)).toBe(true);

    // Rewind: the dropped commit is no longer an ancestor of HEAD.
    git(repo, ["reset", "--hard", second]);
    expect(isAncestor(repo, third)).toBe(false);
    expect(isAncestor(repo, base)).toBe(true);
  });
});

describe("git ledger helpers — commit snapshot", () => {
  it("captures numstat, hunk HEADERS (not the body) and a stable patchId", () => {
    writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\nfour\nfive\n");
    const base = commitAll(repo, "base");

    // Two separated hunks so we can assert more than one header.
    writeFileSync(join(repo, "a.txt"), "one\nTWO\nthree\nfour\nFIVE\n");
    const sha = commitAll(repo, "edit two lines");

    const changes = getCommitChanges(repo, sha);
    expect(changes).not.toBeNull();
    if (!changes) return;

    expect(changes.sha).toBe(sha);
    expect(changes.subject).toBe("edit two lines");
    expect(changes.author).toBe("Git Test");
    expect(changes.authoredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const file = changes.files.find((f) => f.path === "a.txt");
    expect(file).toBeDefined();
    expect(file?.additions).toBe(2);
    expect(file?.deletions).toBe(2);
    expect(file?.hunks.length).toBeGreaterThanOrEqual(2);
    // Hunks are HEADER strings only — never a `+`/`-` body line.
    for (const hunk of file?.hunks ?? []) {
      expect(hunk.startsWith("@@")).toBe(true);
      expect(hunk.startsWith("+")).toBe(false);
      expect(hunk.startsWith("-")).toBe(false);
    }

    expect(changes.patchId).toMatch(SHA_RE);

    // A cherry-pick of the same change yields the SAME patchId (rebase-stable).
    // `-x` appends provenance to the message so the commit sha differs while the
    // diff — and therefore the patch-id — is unchanged.
    git(repo, ["checkout", "-q", "-b", "side", base]);
    git(repo, ["cherry-pick", "-x", sha]);
    const cherrySha = git(repo, ["rev-parse", "HEAD"]);
    expect(cherrySha).not.toBe(sha);
    expect(getCommitChanges(repo, cherrySha)?.patchId).toBe(changes.patchId);
  });

  it("returns null for an invalid or unresolvable sha", () => {
    writeFileSync(join(repo, "a.txt"), "one\n");
    commitAll(repo, "base");
    expect(getCommitChanges(repo, "not-a-sha")).toBeNull();
    expect(getCommitChanges(repo, "deadbeef")).toBeNull();
  });

  it("re-renders the patch body from git", () => {
    writeFileSync(join(repo, "a.txt"), "one\n");
    commitAll(repo, "base");
    writeFileSync(join(repo, "b.txt"), "two\n");
    const sha = commitAll(repo, "add b");

    const patch = getCommitPatch(repo, sha);
    expect(patch).not.toBeNull();
    expect(patch).toContain("diff --git a/b.txt b/b.txt");
    expect(patch).toContain("+++ b/b.txt");
    expect(patch).toContain("+two");

    // Restricting to a non-matching path yields an empty patch.
    expect(getCommitPatch(repo, sha, ["a.txt"])).toBe("");
    expect(getCommitPatch(repo, "deadbeef")).toBeNull();
  });
});

describe("git ledger helpers — worktree diffstat", () => {
  it("enumerates untracked files inside an untracked directory individually", () => {
    writeFileSync(join(repo, "a.txt"), "one\n");
    commitAll(repo, "base");

    mkdirSync(join(repo, "notes", "nested"), { recursive: true });
    writeFileSync(join(repo, "notes", "one.md"), "one\n");
    writeFileSync(join(repo, "notes", "nested", "two.md"), "two\n");
    writeFileSync(join(repo, "root.txt"), "root\n");
    // A tracked edit too.
    writeFileSync(join(repo, "a.txt"), "one\nchanged\n");

    const stat = getWorktreeDiffstat(repo);
    expect(stat).not.toBeNull();
    if (!stat) return;

    // Files inside the untracked directory are listed, not collapsed to `notes/`.
    expect(stat.untracked).toContain("notes/one.md");
    expect(stat.untracked).toContain("notes/nested/two.md");
    expect(stat.untracked).toContain("root.txt");
    expect(stat.untracked).not.toContain("notes/");
    expect(stat.untracked).not.toContain("notes");

    const modified = stat.files.find((f) => f.path === "a.txt");
    expect(modified?.additions).toBe(1);
  });

  it("returns null for a clean worktree", () => {
    writeFileSync(join(repo, "a.txt"), "one\n");
    commitAll(repo, "base");
    expect(getWorktreeDiffstat(repo)).toBeNull();
  });
});
