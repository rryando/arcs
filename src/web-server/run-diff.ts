/**
 * Workspace diff snapshot + approve/revert review surface for Ask-AI runs.
 *
 * The allow-all gate: a run may change the workspace, the panel shows the
 * diff, and the user approves (keeps) or rejects (reverts). Three layers:
 *
 *  - SNAPSHOT — captured in the ask route's spawn path, before the claim is
 *    taken and before the child can write. This is the baseline every later
 *    diff and revert computes against.
 *  - DIFF — computed in the settle write-back, comparing the workspace to the
 *    snapshot, and persisted as `changes.json` beside the run's event log.
 *  - REVERT — restores the workspace to the snapshot baseline, scoped to this
 *    run's own changes list, and marks the run record so a second revert is
 *    refused.
 *
 * Two workspace modes:
 *
 *  - GIT — the snapshot records `{ mode, head, cwd, untracked[] }` and
 *    NOTHING else. Diffs and reverts compute against git at review time
 *    (`git diff HEAD`, `git restore`), because git already holds the exact
 *    baseline — copying file contents would be redundant with the object DB.
 *    `untracked` lists the paths that were already untracked at snapshot time:
 *    the run is never credited with (and revert never deletes) a file that
 *    merely remained untracked across the run. State the degradation plainly:
 *    an untracked file that EXISTED before the run and was then edited by it
 *    is invisible to this surface — git has no baseline for it, by design.
 *  - TREE (non-git) — the snapshot walks the tree and records a hash+size
 *    manifest. A pure manifest can answer modified/added/deleted but cannot
 *    render a modified file's old bytes, so the snapshot ALSO stores each
 *    file's bytes up to a total blob cap (RUN_SNAPSHOT_BLOB_MAX_BYTES). A
 *    file whose baseline bytes were refused by the cap reports `diff: null`
 *    with `capped: true` and cannot be reverted.
 *
 * Every failure here DEGRADES the review surface rather than failing the turn
 * or the settle: an unreadable workspace, a wedged git, a refused blob — all
 * record on the snapshot/change file and the client sees an empty changes
 * list. The turn itself already happened.
 *
 * File keying follows run-event-log.ts exactly: `sessions/{slug}.run-{seg}`
 * plus a `.snapshot.json` / `.changes.json` suffix, pruned together by
 * `pruneRunEventLogs` under the same retention.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readJsonSafe } from "../utils/json.js";
import { normalizeIdentifier } from "../utils/slug.js";
import { ensureDir, writeJson } from "../utils/storage-utils.js";
import { runEventLogSegment } from "./run-event-log.js";

// ---------------------------------------------------------------------------
// Budgets — every number a walk, diff or blob capture may touch
// ---------------------------------------------------------------------------

/** Ceiling on files a non-git snapshot walk records. Past it the walk stops
 *  (sorted order) and the rest of the tree is NOT in the manifest — a
 *  documented truncation: files that sort after the cap compare as phantom
 *  adds/deletes. */
export const RUN_SNAPSHOT_MAX_FILES = 10_000;

/** Ceiling on levels below the workspace root a walk descends. */
export const RUN_SNAPSHOT_MAX_DEPTH = 12;

/** Ceiling on total baseline bytes a snapshot may keep for later diffs. A
 *  modified/deleted file whose bytes were refused CANNOT render a diff or be
 *  reverted — it reports `capped: true` instead. */
export const RUN_SNAPSHOT_BLOB_MAX_BYTES = 20 * 1024 * 1024;

/** Ceiling on one change's diff text — the first N lines AND the first N
 *  bytes, whichever lands first. Line counts are always parsed from the FULL
 *  diff before the cap is applied. */
export const RUN_DIFF_MAX_LINES = 300;
export const RUN_DIFF_MAX_BYTES = 12 * 1024;

/** Ceiling on one spawnSync git call. A wedged git (stalled mount, held
 *  index.lock) must degrade the surface, never hang the request. */
export const RUN_GIT_TIMEOUT_MS = 5_000;

/** Directories a walk skips wholesale. Not a security control — the walk
 *  never leaves the root — but each of these would eat the entry cap alone. */
const WALK_SKIP_DIRECTORIES = new Set([".git", ".codegraph", "node_modules"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkspaceSnapshotFile {
  /** Bytes at snapshot time. */
  size: number;
  /** Hex sha256 of the file's bytes at snapshot time. */
  sha256: string;
}

/** Git-mode snapshot: diffs and reverts compute AGAINST GIT at review time —
 *  no file bytes are copied, which is the point: an exact diff needs git's
 *  whole object database, not our copy of HEAD. */
export interface GitWorkspaceSnapshot {
  mode: "git";
  /** HEAD sha at snapshot time — what the run saw as "current". */
  head: string;
  /** Realpath'd workspace root the snapshot covers — what the run ran in. */
  cwd: string;
  /**
   * Untracked paths at snapshot time. The settle-time diff never credits the
   * run with a file that was ALREADY untracked (git has no baseline for it),
   * and revert never deletes one. This list IS the git mode's "snapshot path
   * list" that revert scopes itself to.
   */
  untracked: string[];
  /** Non-fatal capture failure — the review surface is skipped for the run
   *  (GET changes answers an empty list) rather than failing the turn. */
  error?: string;
}

/** Tree-mode snapshot (non-git): a manifest walk plus baseline bytes. */
export interface TreeWorkspaceSnapshot {
  mode: "tree";
  cwd: string;
  /** Relative posix path → size + sha256, for every walked file. */
  files: Record<string, WorkspaceSnapshotFile>;
  /**
   * Baseline bytes (base64) up to RUN_SNAPSHOT_BLOB_MAX_BYTES total, in
   * sorted walk order — the only way a non-git modified/deleted file can
   * render a diff or be reverted.
   */
  blobs: Record<string, string>;
  /** The walk's caps, so the settle-time diff re-walks identically. */
  walk: { maxFiles: number; maxDepth: number };
  /** True when the walk hit the file cap — later files were not walked, so
   *  they compare as phantom adds/removes. Documented degradation. */
  truncated?: boolean;
  /** True when at least one file was refused baseline bytes past the blob cap. */
  blobCapped?: boolean;
  /** Non-fatal capture failure — same degradation as the git-mode `error`. */
  error?: string;
}

export type WorkspaceSnapshot = GitWorkspaceSnapshot | TreeWorkspaceSnapshot;

export type WorkspaceChangeStatus = "modified" | "added" | "deleted";

export interface WorkspaceChange {
  /** Posix path relative to the workspace root. */
  path: string;
  status: WorkspaceChangeStatus;
  /** `+` lines in the FULL diff (before capping). */
  linesAdded: number;
  /** `-` lines in the FULL diff (before capping). */
  linesRemoved: number;
  /** Capped diff text (RUN_DIFF_MAX_LINES × RUN_DIFF_MAX_BYTES), or `null`
   *  when the bytes to render it were never captured (blob cap) or a git
   *  call failed. */
  diff: string | null;
  /** True when `diff` is null because the file's baseline bytes were beyond
   *  the snapshot's blob cap — the non-git degradation flag. Revert cannot
   *  rebuild such a file either. */
  capped?: boolean;
}

/** The persisted `changes.json` manifest beside a run's event log. */
export interface RunChangesFile {
  runId: string;
  /** Epoch ms the settle-time diff was computed. */
  computedAt: number;
  changes: WorkspaceChange[];
  /** Non-fatal diff failure — the client sees changes: []. */
  error?: string;
}

export interface SnapshotOptions {
  maxFiles?: number;
  maxDepth?: number;
  blobMaxBytes?: number;
}

// ---------------------------------------------------------------------------
// Git plumbing — spawnSync, never a shell, always timed
// ---------------------------------------------------------------------------

interface GitResult {
  /** Exit non-zero, spawn error, or timeout. */
  failed: boolean;
  stdout: string;
}

/**
 * One git call against `root`. `spawnSync` with a hard timeout: sync git on
 * the server is a deliberate trade, because the snapshot is captured inline in
 * the spawn path and the diff/revert run inline in the settle/review path —
 * each is a handful of quick calls, and a wedged git must fail closed to
 * "degrade the surface", not hang the request (that is what the timeout is
 * for).
 */
function runGit(root: string, args: string[], timeoutMs: number = RUN_GIT_TIMEOUT_MS): GitResult {
  try {
    const proc = spawnSync("git", ["-C", root, ...args], {
      encoding: "utf-8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      failed: proc.error !== undefined || proc.status !== 0,
      stdout: typeof proc.stdout === "string" ? proc.stdout : "",
    };
  } catch {
    return { failed: true, stdout: "" };
  }
}

// ---------------------------------------------------------------------------
// Containment — nothing outside the snapshot's root
// ---------------------------------------------------------------------------

/**
 * Segment-aware containment of a root-relative path (exactly the rule the
 * workspace route uses): `relative()` alone is not enough — a `startsWith` on
 * its output rejects a legitimate file literally named `..foo`, and a
 * `startsWith` on the raw paths accepts `/repo-secrets` for root `/repo`.
 * Returns the absolute path, or null when the path escapes the root. Every
 * read, diff, revert and delete the surface performs goes through this.
 */
function resolveInside(root: string, relPath: string): string | null {
  if (relPath === "" || isAbsolute(relPath)) return null;
  const abs = resolve(root, relPath);
  const rel = relative(root, abs);
  if (rel === "" || isAbsolute(rel) || rel.split(sep).includes("..")) return null;
  return abs;
}

// ---------------------------------------------------------------------------
// Snapshot capture
// ---------------------------------------------------------------------------

/**
 * Total by contract: NEVER throws. Every failure mode records `error` on the
 * snapshot, and an errored snapshot skips the review surface for its run
 * (changes: [], revert no-ops) — a baseline that cannot be computed must not
 * fail the accepted turn.
 */
export async function captureWorkspaceSnapshot(
  root: string,
  options: SnapshotOptions = {},
): Promise<WorkspaceSnapshot> {
  // Resolve the root FIRST — the snapshot, diff and revert must all agree on
  // the canonical path, and a root that reaches through a symlink must not
  // contain a different set of files than the CLI thinks it does.
  const cwd = await realpath(root).catch(() => null);
  if (cwd === null) {
    return {
      mode: "tree",
      cwd: root,
      files: {},
      blobs: {},
      walk: walkCaps(options),
      error: `workspace "${root}" is not readable on this machine`,
    };
  }

  // Git detection: `git rev-parse --git-dir` succeeding from the workspace
  // root (a `.git` dir OR file — worktrees and submodules included — "at or
  // near root"). Its failure is the non-git branch, not an error.
  if (!runGit(cwd, ["rev-parse", "--git-dir"]).failed) {
    const head = runGit(cwd, ["rev-parse", "HEAD"]);
    if (head.failed) {
      return {
        mode: "git",
        cwd,
        head: "",
        untracked: [],
        error:
          "git HEAD is not readable (empty repository? stash?) — the run has no baseline to diff against",
      };
    }
    const untracked = runGit(cwd, ["ls-files", "--others", "--exclude-standard"]);
    return {
      mode: "git",
      cwd,
      head: head.stdout.trim(),
      untracked: untracked.failed ? [] : untracked.stdout.split("\n").filter((line) => line !== ""),
    };
  }

  const walked = await walkWorkspace(cwd, options);
  const snapshot: TreeWorkspaceSnapshot = {
    mode: "tree",
    cwd,
    files: walked.files,
    blobs: walked.blobs,
    walk: walked.walk,
    ...(walked.blobCapped && { blobCapped: true }),
    ...(walked.error !== undefined && { error: walked.error }),
  };
  return snapshot;
}

function walkCaps(options: SnapshotOptions): { maxFiles: number; maxDepth: number } {
  return {
    maxFiles: options.maxFiles ?? RUN_SNAPSHOT_MAX_FILES,
    maxDepth: options.maxDepth ?? RUN_SNAPSHOT_MAX_DEPTH,
  };
}

interface WalkResult {
  files: Record<string, WorkspaceSnapshotFile>;
  blobs: Record<string, string>;
  walk: { maxFiles: number; maxDepth: number };
  blobCapped: boolean;
  /** True when the walk hit the file cap and stopped early. */
  truncated: boolean;
  error?: string;
}

/**
 * Walks the workspace tree: every file's size + sha256, plus baseline bytes
 * (base64) up to the blob cap. Deterministic — sorted entry order, so the
 * file cap cuts the same set on every walk of the same tree.
 */
async function walkWorkspace(root: string, options: SnapshotOptions): Promise<WalkResult> {
  const maxFiles = options.maxFiles ?? RUN_SNAPSHOT_MAX_FILES;
  const maxDepth = options.maxDepth ?? RUN_SNAPSHOT_MAX_DEPTH;
  const blobMaxBytes = options.blobMaxBytes ?? RUN_SNAPSHOT_BLOB_MAX_BYTES;
  const files: Record<string, WorkspaceSnapshotFile> = {};
  const blobs: Record<string, string> = {};
  let fileCount = 0;
  let blobBytes = 0;
  let blobCapped = false;
  let hitFileCap = false;

  // The walk probes the root listing up front so an unreadable root is an
  // ERROR on the snapshot, not a silent empty manifest (an empty baseline
  // would diff every surviving file as "added" — wrong in the dangerous
  // direction).
  try {
    await readdir(root, { withFileTypes: true });
  } catch (err) {
    return {
      files: {},
      blobs: {},
      walk: { maxFiles, maxDepth },
      blobCapped: false,
      truncated: false,
      error: `workspace "${root}" is not readable: ${String(err)}`,
    };
  }

  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    let entries: import("node:fs").Dirent<string>[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // an unreadable subdirectory drops out of the manifest
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (fileCount >= maxFiles) {
        hitFileCap = true;
        return;
      }
      if (WALK_SKIP_DIRECTORIES.has(entry.name)) continue;
      // Symlinks are skipped ENTIRELY: following one could step outside the
      // root or into a cycle, and "never touch outside the root" is cheaper
      // to keep absolute than to carve symlink exceptions. A workspace that
      // leans on symlinked files simply has a smaller review surface.
      if (entry.isSymbolicLink()) continue;
      const abs = join(dir, entry.name);
      const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(abs, relPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      fileCount += 1;

      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(abs);
      } catch {
        continue;
      }
      if (!info.isFile()) continue;
      const sha256 = await sha256File(abs);
      if (sha256 === null) continue;
      files[relPath] = { size: info.size, sha256 };

      // Baseline bytes, first-come within sorted order, up to the total cap.
      // A file that does NOT fit is refused ITS blob only — `blobCapped`
      // records that at least one file lacks one, and later (smaller) files
      // that still fit keep theirs.
      if (info.size > 0) {
        if (info.size <= blobMaxBytes - blobBytes) {
          try {
            const buf = await readFile(abs);
            blobs[relPath] = buf.toString("base64");
            blobBytes += buf.length;
          } catch {
            // Hash recorded, no blob — this file's diff/revert degrades per-file.
          }
        } else {
          blobCapped = true;
        }
      }
    }
  };
  await walk(root, "", 0);

  return {
    files,
    blobs,
    walk: { maxFiles, maxDepth },
    blobCapped,
    truncated: hitFileCap,
  };
}

async function sha256File(abs: string): Promise<string | null> {
  try {
    const buf = await readFile(abs);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sidecar files — keyed on the run, pruned with the run's event log
// ---------------------------------------------------------------------------

const SNAPSHOT_SUFFIX = ".snapshot.json";
const CHANGES_SUFFIX = ".changes.json";

function sidecarName(sessionId: string, runId: string, suffix: string): string {
  return `${normalizeIdentifier(sessionId)}.run-${runEventLogSegment(runId)}${suffix}`;
}

/** The run's baseline snapshot path — a sibling of its event log. */
export function runSnapshotPath(projectDir: string, sessionId: string, runId: string): string {
  return join(projectDir, "sessions", sidecarName(sessionId, runId, SNAPSHOT_SUFFIX));
}

/** The run's settle-time changes manifest path — a sibling of its event log. */
export function runChangesPath(projectDir: string, sessionId: string, runId: string): string {
  return join(projectDir, "sessions", sidecarName(sessionId, runId, CHANGES_SUFFIX));
}

/** Persists the baseline snapshot. Callers wrap this — a failed persist is a
 *  degraded review surface, never a failed turn. */
export async function persistRunSnapshot(
  projectDir: string,
  sessionId: string,
  runId: string,
  snapshot: WorkspaceSnapshot,
): Promise<void> {
  await ensureDir(dirname(runSnapshotPath(projectDir, sessionId, runId)));
  await writeJson(runSnapshotPath(projectDir, sessionId, runId), snapshot);
}

export async function readRunSnapshot(
  projectDir: string,
  sessionId: string,
  runId: string,
): Promise<WorkspaceSnapshot | undefined> {
  return readJsonSafe<WorkspaceSnapshot>(runSnapshotPath(projectDir, sessionId, runId));
}

export async function readRunChanges(
  projectDir: string,
  sessionId: string,
  runId: string,
): Promise<RunChangesFile | undefined> {
  return readJsonSafe<RunChangesFile>(runChangesPath(projectDir, sessionId, runId));
}

// ---------------------------------------------------------------------------
// Diff — the settle-time comparison against the snapshot
// ---------------------------------------------------------------------------

/**
 * What the workspace changed since the snapshot.
 *
 * Total by contract (never throws): the git-status failure path returns an
 * empty list — a workspace whose git broke mid-run degrades to "no changes"
 * rather than failing the settle. Every path it returns is root-relative, so
 * downstream reads, diffs and reverts all go through `resolveInside`.
 */
export async function computeWorkspaceChanges(
  snapshot: WorkspaceSnapshot,
): Promise<WorkspaceChange[]> {
  if (snapshot.error !== undefined) return [];
  return snapshot.mode === "git"
    ? await gitWorkspaceChanges(snapshot)
    : await treeWorkspaceChanges(snapshot);
}

interface ParsedGitEntry {
  index: string;
  worktree: string;
  /** For a rename/copy, the pre-move path (left of " -> "). */
  oldPath?: string;
  path: string;
}

/**
 * Splits `git status --porcelain=v1` lines into entries. Handles the
 * C-quoted paths porcelain emits for spaces/unicode (`"a\tb"`), via a small
 * unquoter matching git's core.quotePath escapes.
 */
function parseGitStatus(stdout: string): ParsedGitEntry[] {
  const entries: ParsedGitEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length < 4) continue;
    const index = line[0] as string;
    const worktree = line[1] as string;
    const rawPath = line.slice(3);
    if (rawPath === "") continue;
    const arrow = rawPath.indexOf(" -> ");
    const entry: ParsedGitEntry = {
      index,
      worktree,
      path: unquoteGitPath(arrow === -1 ? rawPath : rawPath.slice(arrow + 4)),
      ...(arrow !== -1 && { oldPath: unquoteGitPath(rawPath.slice(0, arrow)) }),
    };
    entries.push(entry);
  }
  return entries;
}

function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  let out = "";
  for (let i = 1; i < raw.length - 1; i++) {
    const ch = raw[i] as string;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = raw[i + 1] as string | undefined;
    if (next === undefined) break;
    const simple: Record<string, string> = {
      a: "\x07",
      b: "\b",
      t: "\t",
      n: "\n",
      v: "\v",
      f: "\f",
      r: "\r",
      '"': '"',
      "\\": "\\",
    };
    if (simple[next] !== undefined) {
      out += simple[next];
      i += 1;
      continue;
    }
    // Octal escape `\ooo` (non-ASCII paths).
    if (/^[0-7]/.test(next)) {
      const octal = raw.slice(i + 1, i + 4);
      out += String.fromCharCode(Number.parseInt(octal, 8));
      i += 3;
      continue;
    }
    out += next;
    i += 1;
  }
  return out;
}

async function gitWorkspaceChanges(snapshot: GitWorkspaceSnapshot): Promise<WorkspaceChange[]> {
  const status = runGit(snapshot.cwd, ["status", "--porcelain=v1"]);
  if (status.failed) return [];

  const preexistingUntracked = new Set(snapshot.untracked);
  const changes: WorkspaceChange[] = [];
  for (const entry of parseGitStatus(status.stdout)) {
    // Untracked (`??`). A path that was ALREADY untracked at snapshot time is
    // the baseline, not a run change — git has no baseline for it, so the run
    // is neither credited with it nor blamed for it.
    if (entry.index === "?") {
      if (preexistingUntracked.has(entry.path)) continue;
      changes.push(await trackedChange(snapshot, "added", entry.path, true));
      continue;
    }

    // A rename decomposes into a deletion + an addition — the two half-diffs
    // are each revertable, and together they undo the move exactly.
    if (entry.oldPath !== undefined && (entry.index === "R" || entry.worktree === "R")) {
      changes.push(await trackedChange(snapshot, "deleted", entry.oldPath, false));
      changes.push(await trackedChange(snapshot, "added", entry.path, false));
      continue;
    }
    // A copy is an addition at the new path; the source is untouched.
    if (entry.index === "C" || entry.worktree === "C") {
      changes.push(await trackedChange(snapshot, "added", entry.path, false));
      continue;
    }
    if (entry.index === "D" || entry.worktree === "D") {
      changes.push(await trackedChange(snapshot, "deleted", entry.path, false));
    } else if (entry.index === "A" || entry.worktree === "A") {
      changes.push(await trackedChange(snapshot, "added", entry.path, false));
    } else if (
      entry.index === "M" ||
      entry.worktree === "M" ||
      entry.index === "U" ||
      entry.worktree === "U"
    ) {
      changes.push(await trackedChange(snapshot, "modified", entry.path, false));
    }
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * One change's diff for git mode. Tracked paths diff with `git diff HEAD --`
 * (which covers index AND worktree changes against HEAD in one call, staged
 * counts included); only a settle-time-untracked file is synthesized by hand
 * (`+N `-numbered lines — git has nothing to diff it against).
 */
async function trackedChange(
  snapshot: GitWorkspaceSnapshot,
  status: WorkspaceChangeStatus,
  path: string,
  untracked: boolean,
): Promise<WorkspaceChange> {
  if (status === "added" && untracked) {
    const rendered = await untrackedFileDiff(resolveInside(snapshot.cwd, path));
    return {
      path,
      status,
      linesAdded: rendered?.linesAdded ?? 0,
      linesRemoved: 0,
      diff: rendered?.diff ?? null,
    };
  }
  const out = runGit(snapshot.cwd, ["diff", "HEAD", "--", path]);
  if (out.failed) {
    return { path, status, linesAdded: 0, linesRemoved: 0, diff: null };
  }
  const counts = countDiffLines(out.stdout);
  return { path, status, ...counts, diff: capDiff(out.stdout) };
}

async function treeWorkspaceChanges(snapshot: TreeWorkspaceSnapshot): Promise<WorkspaceChange[]> {
  const walked = await walkWorkspace(snapshot.cwd, {
    maxFiles: snapshot.walk.maxFiles,
    maxDepth: snapshot.walk.maxDepth,
  });
  const changes: WorkspaceChange[] = [];
  const paths = new Set([...Object.keys(snapshot.files), ...Object.keys(walked.files)]);
  for (const path of [...paths].sort()) {
    const was = snapshot.files[path];
    const now = walked.files[path];
    if (was !== undefined && now !== undefined) {
      // Size differs, or size matches but the content hash does not.
      if (was.size === now.size && was.sha256 === now.sha256) continue;
      const rendered = await treeModifiedDiff(snapshot, path);
      changes.push({
        path,
        status: "modified",
        linesAdded: rendered?.added ?? 0,
        linesRemoved: rendered?.removed ?? 0,
        diff: rendered?.diff ?? null,
        ...(rendered === null && { capped: true }),
      });
    } else if (was !== undefined) {
      const blob = snapshot.blobs[path];
      if (blob === undefined) {
        // Deleted beyond the blob cap: no baseline bytes, no diff, no revert.
        changes.push({
          path,
          status: "deleted",
          linesAdded: 0,
          linesRemoved: 0,
          diff: null,
          capped: true,
        });
        continue;
      }
      const lines = splitLines(Buffer.from(blob, "base64").toString("utf-8"));
      const body = lines.map((line, i) => `-${i + 1} ${line}`).join("\n");
      changes.push({
        path,
        status: "deleted",
        linesAdded: 0,
        linesRemoved: lines.length,
        diff: capDiff(body),
      });
    } else {
      const rendered = await untrackedFileDiff(resolveInside(snapshot.cwd, path));
      changes.push({
        path,
        status: "added",
        linesAdded: rendered?.linesAdded ?? 0,
        linesRemoved: 0,
        diff: rendered?.diff ?? null,
      });
    }
  }
  return changes;
}

/**
 * Non-git modified-file diff: the snapshot's baseline bytes vs the file's
 * current bytes, rendered as numbered `-` old lines then numbered `+` new
 * lines. Not a line-aligned LCS diff — an honest whole-file before/after is
 * the degradation contract (and both halves are capped anyway).
 */
async function treeModifiedDiff(
  snapshot: TreeWorkspaceSnapshot,
  path: string,
): Promise<{ diff: string; added: number; removed: number } | null> {
  const blob = snapshot.blobs[path];
  if (blob === undefined) return null;
  const abs = resolveInside(snapshot.cwd, path);
  if (abs === null) return null;
  let newText: string;
  try {
    newText = await readFile(abs, "utf-8");
  } catch {
    return null;
  }
  const oldLines = splitLines(Buffer.from(blob, "base64").toString("utf-8"));
  const newLines = splitLines(newText);
  const body = [
    ...oldLines.map((line, i) => `-${i + 1} ${line}`),
    ...newLines.map((line, i) => `+${i + 1} ${line}`),
  ].join("\n");
  return { diff: capDiff(body), added: newLines.length, removed: oldLines.length };
}

/** The settle-time-untracked file's whole content, `+N`-numbered. */
async function untrackedFileDiff(
  absPath: string | null,
): Promise<{ diff: string; linesAdded: number } | null> {
  if (absPath === null) return null;
  try {
    const text = await readFile(absPath, "utf-8");
    const lines = splitLines(text);
    const body = lines.map((line, i) => `+${i + 1} ${line}`).join("\n");
    return { diff: capDiff(body), linesAdded: lines.length };
  } catch {
    return null;
  }
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * `+`/`-` record-line counts from a FULL diff: `+++`/`---` headers and `@@`
 * hunk headers are markers, not record lines. Used for git's native output
 * and only counts what the diff actually shows for the changed regions.
 */
function countDiffLines(text: string): { linesAdded: number; linesRemoved: number } {
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) linesAdded += 1;
    else if (line.startsWith("-")) linesRemoved += 1;
  }
  return { linesAdded, linesRemoved };
}

/** First RUN_DIFF_MAX_LINES lines, then at most RUN_DIFF_MAX_BYTES bytes. */
function capDiff(text: string): string {
  const lines = text.split("\n");
  const kept = lines.length > RUN_DIFF_MAX_LINES ? lines.slice(0, RUN_DIFF_MAX_LINES) : lines;
  let out = kept.join("\n");
  if (out.length > RUN_DIFF_MAX_BYTES) out = out.slice(0, RUN_DIFF_MAX_BYTES);
  return out;
}

// ---------------------------------------------------------------------------
// Settle-time orchestration — called from the write-back
// ---------------------------------------------------------------------------

/**
 * Computes the run's workspace diff and persists it as changes.json beside
 * the run's event log. Never throws: a missing/errored snapshot leaves the
 * changes file absent (GET answers `changes: []`), and a diff failure writes
 * `{ changes: [], error }` so the run still reads as "no changes".
 */
export async function writeSettledRunChanges(
  projectDir: string,
  sessionId: string,
  runId: string,
): Promise<void> {
  const snapshot = await readRunSnapshot(projectDir, sessionId, runId);
  if (snapshot === undefined || snapshot.error !== undefined) return;

  let changes: WorkspaceChange[] = [];
  let error: string | undefined;
  try {
    changes = await computeWorkspaceChanges(snapshot);
  } catch (err) {
    error = String(err);
  }
  await writeJson(runChangesPath(projectDir, sessionId, runId), {
    runId,
    computedAt: Date.now(),
    changes,
    ...(error !== undefined && { error }),
  });
}

// ---------------------------------------------------------------------------
// Revert — the reject half of the approve/revert surface
// ---------------------------------------------------------------------------

/**
 * Restores the workspace to the snapshot baseline for THIS run's changes.
 *
 * Scoped strictly: every path goes through `resolveInside` against the
 * snapshot root, and the paths acted on are exactly those in `changes` (never
 * a bare `git clean`, never a walk). Returns the paths actually restored;
 * un-restorable entries (a modified/deleted file whose baseline bytes were
 * beyond the blob cap) are skipped and NOT reported as restored.
 */
export async function revertWorkspaceChanges(
  snapshot: WorkspaceSnapshot,
  changes: WorkspaceChange[],
): Promise<string[]> {
  if (snapshot.error !== undefined) return [];
  return snapshot.mode === "git" ? gitRevert(snapshot, changes) : treeRevert(snapshot, changes);
}

async function gitRevert(
  snapshot: GitWorkspaceSnapshot,
  changes: WorkspaceChange[],
): Promise<string[]> {
  const restored: string[] = [];
  for (const change of changes) {
    if (change.status === "added") {
      // Never delete a path that existed before the run — the settle-time
      // compute already excludes pre-existing untracked paths, so this check
      // is defensive depth against a hand-edited changes file, not the
      // load-bearing guard.
      if (snapshot.untracked.includes(change.path)) continue;
      const abs = resolveInside(snapshot.cwd, change.path);
      if (abs === null) continue;
      try {
        rmSync(abs, { force: true });
        restored.push(change.path);
      } catch {
        // Already gone or undeletable — keep going.
      }
      continue;
    }
    // Tracked modified/deleted: restore the worktree (AND index, so staged
    // changes ride along) from HEAD. The bare `git restore -- <path>` form is
    // the fallback for hosts/index states the combined form refuses.
    const primary = runGit(snapshot.cwd, [
      "restore",
      "--source=HEAD",
      "--staged",
      "--worktree",
      "--",
      change.path,
    ]);
    if (primary.failed) {
      const fallback = runGit(snapshot.cwd, ["restore", "--", change.path]);
      if (fallback.failed) continue;
    }
    restored.push(change.path);
  }
  return restored;
}

async function treeRevert(
  snapshot: TreeWorkspaceSnapshot,
  changes: WorkspaceChange[],
): Promise<string[]> {
  const restored: string[] = [];
  for (const change of changes) {
    const abs = resolveInside(snapshot.cwd, change.path);
    if (abs === null) continue;
    if (change.status === "added") {
      try {
        await rm(abs, { force: true });
        restored.push(change.path);
      } catch {
        // Already gone or undeletable — keep going.
      }
      continue;
    }
    const blob = snapshot.blobs[change.path];
    if (blob === undefined) continue; // beyond the blob cap — cannot rebuild
    try {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, Buffer.from(blob, "base64"));
      restored.push(change.path);
    } catch {
      // Unwritable — keep going.
    }
  }
  return restored;
}
