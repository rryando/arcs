/**
 * Read-only workspace file plane — the surface a user points at.
 *
 * Two GETs and nothing else: `tree` lists a directory under the project's
 * registered workspace roots, `file` returns one file's text plus the head
 * revision it was read at, so the browser can build the `file` variant of
 * `sessionReferenceSchema` (path + line range + headRev) and hand it to a
 * session. There is deliberately NO write route here: an edit is something the
 * agent does in the workspace, never something this plane does on its behalf.
 *
 * Every path the caller supplies goes through `resolveInsideWorkspace` — the
 * one containment guard — which resolves symlinks BEFORE deciding whether the
 * result is inside a root. Both routes are cheap to abuse otherwise, so both
 * are also capped: bytes on the file route, depth and entry count on the tree.
 */

import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Hono } from "hono";
import { DagError } from "../../utils/errors.js";
import { getHeadCommitAsync } from "../../utils/git.js";
import { readJsonSafe } from "../../utils/json.js";
import { requireProjectDir, respond } from "../respond.js";

export const workspaceRoute = new Hono();

/** Ceiling on the bytes one file response may carry. Past it the response is
 *  the first slice plus `truncated: true` — never the whole file, and never a
 *  stream this plane would have to keep open. */
export const WORKSPACE_FILE_MAX_BYTES = 256 * 1024;

/** Ceiling on entries in one tree response, across every level walked. */
export const WORKSPACE_TREE_MAX_ENTRIES = 500;

/** Ceiling on how many levels below the requested directory a walk descends.
 *  A larger `?depth=` is clamped to this, never honoured. */
export const WORKSPACE_TREE_MAX_DEPTH = 4;

/**
 * Directories skipped by the walk. Not a security control — the guard is — but
 * either of these would exhaust the entry cap on its own and leave the tree
 * showing nothing a user came to look at.
 */
const SKIP_DIRECTORIES = new Set([".git", "node_modules"]);

interface WorkspaceEntry {
  name: string;
  /** Path relative to the workspace root — what both routes take back. */
  path: string;
  type: "dir" | "file";
}

interface ResolvedWorkspacePath {
  /** Symlink-free absolute path, proven inside `root`. */
  real: string;
  /** The workspace root it lives under, itself already resolved. */
  root: string;
  /** `real` relative to `root`; `""` for the root itself. */
  relPath: string;
}

// ---------------------------------------------------------------------------
// Roots + containment
// ---------------------------------------------------------------------------

/**
 * `~/x` → `<home>/x`, anything else made absolute.
 *
 * Mirrors `expandWorkspacePath` in src/utils/project-resolver.ts, which is
 * module-private there. Same two-branch rule, deliberately not re-derived: a
 * root expanded differently from the way the rest of ARCS expands it would
 * contain a different set of files than the CLI thinks it does.
 */
function expandWorkspacePath(configured: string): string {
  return configured.startsWith("~") ? resolve(homedir(), configured.slice(2)) : resolve(configured);
}

/**
 * Segment-aware containment. `relative()` alone is not enough: a `startsWith`
 * on its output rejects a legitimate file literally named `..foo`, and a
 * `startsWith` on the raw paths accepts `/repo-secrets` for root `/repo`.
 */
function isInside(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel !== "" && !isAbsolute(rel) && !rel.split(sep).includes("..");
}

/** Root-relative paths go over the wire with `/` separators regardless of host. */
function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/**
 * The project's workspace roots, resolved and deduplicated.
 *
 * Read from `meta.workspacePaths` exactly as `primaryWorkspacePath` in
 * routes/sessions.ts reads it, including its rule: an unset workspace is an
 * ERROR, never a default. `resolveProject().workspacePath` returns `""` rather
 * than `process.cwd()` for the same reason — an empty root here would otherwise
 * quietly mean "contain everything", i.e. the whole filesystem.
 *
 * The roots are realpath'd because containment compares them against realpath'd
 * targets: on a host whose configured root passes through a symlink (a
 * symlinked tmpdir, a `~/code` → volume link) an unresolved root would fail to
 * contain its own children.
 */
async function workspaceRoots(projectDir: string, slug: string): Promise<string[]> {
  const meta = await readJsonSafe<{ workspacePaths?: string[] }>(resolve(projectDir, "meta.json"));
  const configured = (meta?.workspacePaths ?? []).filter(
    (path): path is string => typeof path === "string" && path.trim() !== "",
  );
  if (configured.length === 0) {
    throw new DagError(
      "PROJECT_WORKSPACE_UNSET",
      `Project "${slug}" has no registered workspace path, so there is no directory to browse — ` +
        `run \`arcs project update-paths ${slug} --add <path>\` first.`,
    );
  }

  const roots: string[] = [];
  for (const path of configured) {
    const real = await realpath(expandWorkspacePath(path)).catch(() => null);
    if (real !== null && !roots.includes(real)) roots.push(real);
  }
  if (roots.length === 0) {
    throw new DagError(
      "PROJECT_WORKSPACE_UNREADABLE",
      `None of the workspace paths registered for project "${slug}" exist on this machine.`,
    );
  }
  return roots;
}

/**
 * Resolves a caller-supplied path against the workspace roots, or refuses it.
 *
 * RESOLVE FIRST, CONTAIN SECOND — this ordering is the entire point of the
 * function. `realpath` collapses every symlink in every segment, so the value
 * that gets contained is the path the filesystem would actually read. A guard
 * that normalizes the REQUESTED STRING and containment-checks that instead
 * admits `<root>/link` for any link at all: the string is inside the root, the
 * bytes are not. These two steps must never be reordered or short-circuited.
 *
 * Both failure modes return before a single byte is read. Anything that DID
 * resolve and landed outside is forbidden (400) — a lexically-inside symlink
 * whose target escapes is exactly that case and must not be softened into a
 * miss. Only a path that resolves to nothing at all consults the lexical test,
 * purely to choose between 404 and 400; that test is never load-bearing for
 * access.
 */
async function resolveInsideWorkspace(
  roots: string[],
  requested: string,
): Promise<ResolvedWorkspacePath> {
  const candidates = isAbsolute(requested)
    ? [requested]
    : roots.map((root) => resolve(root, requested));

  let resolvedOutside = false;
  for (const candidate of candidates) {
    // 1. RESOLVE — every symlink in every segment collapses here.
    const real = await realpath(candidate).catch(() => null);
    if (real === null) continue;
    // 2. CONTAIN — on the resolved path, never on the requested string.
    const root = roots.find((candidateRoot) => isInside(candidateRoot, real));
    if (root) return { real, root, relPath: toPosix(relative(root, real)) };
    resolvedOutside = true;
  }

  const lexicallyInside =
    !resolvedOutside &&
    candidates.some((candidate) => roots.some((root) => isInside(root, candidate)));
  if (lexicallyInside) {
    throw new DagError(
      "WORKSPACE_PATH_NOT_FOUND",
      `"${requested}" does not exist in the project workspace`,
    );
  }
  throw new DagError(
    "WORKSPACE_PATH_FORBIDDEN",
    "Requested path resolves outside the project's workspace roots",
  );
}

// ---------------------------------------------------------------------------
// GET /api/p/:slug/workspace/tree — one directory, depth- and entry-capped
// ---------------------------------------------------------------------------

function clampDepth(raw: string | undefined): number {
  const parsed = Number(raw ?? "1");
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(Math.max(1, Math.trunc(parsed)), WORKSPACE_TREE_MAX_DEPTH);
}

/**
 * Depth-first collection into `out`, returning whether a cap cut the walk short.
 *
 * A symlinked entry is resolved and contained before it is listed at all, so
 * the tree never advertises a door the file route would then refuse to open —
 * and never names a file living outside the root.
 */
async function collectEntries(
  root: string,
  dir: string,
  remainingDepth: number,
  out: WorkspaceEntry[],
): Promise<boolean> {
  if (remainingDepth <= 0) return false;

  const dirents = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (dirents === null) return false;

  const resolved: { name: string; abs: string; type: "dir" | "file" }[] = [];
  for (const dirent of dirents) {
    if (SKIP_DIRECTORIES.has(dirent.name)) continue;
    const abs = join(dir, dirent.name);

    if (dirent.isSymbolicLink()) {
      const real = await realpath(abs).catch(() => null);
      if (real === null || !isInside(root, real)) continue;
      const stats = await stat(real).catch(() => null);
      if (stats === null) continue;
      resolved.push({ name: dirent.name, abs: real, type: stats.isDirectory() ? "dir" : "file" });
      continue;
    }
    if (dirent.isDirectory()) resolved.push({ name: dirent.name, abs, type: "dir" });
    else if (dirent.isFile()) resolved.push({ name: dirent.name, abs, type: "file" });
  }

  resolved.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
  );

  let truncated = false;
  for (const entry of resolved) {
    if (out.length >= WORKSPACE_TREE_MAX_ENTRIES) return true;
    out.push({ name: entry.name, path: toPosix(relative(root, entry.abs)), type: entry.type });
    if (entry.type === "dir") {
      truncated = (await collectEntries(root, entry.abs, remainingDepth - 1, out)) || truncated;
    }
  }
  return truncated;
}

workspaceRoute.get("/api/p/:slug/workspace/tree", async (c) =>
  respond(c, async () => {
    const slug = c.req.param("slug");
    const projectDir = requireProjectDir(slug);
    const roots = await workspaceRoots(projectDir, slug);

    const target = await resolveInsideWorkspace(roots, c.req.query("path") ?? "");
    const stats = await stat(target.real);
    if (!stats.isDirectory()) {
      throw new DagError(
        "WORKSPACE_NOT_A_DIRECTORY",
        `"${target.relPath}" is not a directory — read it with the file route instead`,
      );
    }

    const depth = clampDepth(c.req.query("depth"));
    const entries: WorkspaceEntry[] = [];
    const truncated = await collectEntries(target.root, target.real, depth, entries);

    return { root: target.root, path: target.relPath, depth, entries, truncated };
  }),
);

// ---------------------------------------------------------------------------
// GET /api/p/:slug/workspace/file — one file's text, byte-capped
// ---------------------------------------------------------------------------

/** Lines a viewer would render: a trailing newline terminates the last line
 *  rather than starting an empty one. */
function countLines(content: string): number {
  if (content === "") return 0;
  return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
}

workspaceRoute.get("/api/p/:slug/workspace/file", async (c) =>
  respond(c, async () => {
    const slug = c.req.param("slug");
    const projectDir = requireProjectDir(slug);
    const roots = await workspaceRoots(projectDir, slug);

    const requested = c.req.query("path") ?? "";
    if (requested === "") {
      throw new DagError("WORKSPACE_PATH_REQUIRED", "A `path` query parameter is required");
    }

    const target = await resolveInsideWorkspace(roots, requested);
    const stats = await stat(target.real);
    if (!stats.isFile()) {
      throw new DagError(
        "WORKSPACE_NOT_A_FILE",
        `"${target.relPath}" is not a regular file — list it with the tree route instead`,
      );
    }

    // Capped at the read, not after it: a multi-gigabyte file must never be
    // pulled into memory just to be sliced.
    const length = Math.min(stats.size, WORKSPACE_FILE_MAX_BYTES);
    const buffer = Buffer.alloc(length);
    const handle = await open(target.real, "r");
    try {
      if (length > 0) await handle.read(buffer, 0, length, 0);
    } finally {
      await handle.close();
    }

    // A NUL byte means this is not text; a line-numbered viewer would render
    // garbage and the excerpt on any reference built from it would be noise.
    if (buffer.includes(0)) {
      throw new DagError(
        "WORKSPACE_FILE_BINARY",
        `"${target.relPath}" is not a text file — this plane serves text only`,
      );
    }

    const content = buffer.toString("utf-8");
    return {
      path: target.relPath,
      root: target.root,
      content,
      lineCount: countLines(content),
      size: stats.size,
      truncated: stats.size > length,
      // The revision the slice was taken at, so a `file` reference built from
      // this response carries `headRev` and a later diff can tell whether the
      // file moved under the agent. `null` outside a git worktree.
      //
      // The ASYNC twin, deliberately: `getHeadCommit` is `execSync`, and a
      // sync spawn in a handler blocks the entire loop for the child's whole
      // lifetime, which every concurrent request and every open SSE stream pays
      // too. Both the cost and the saving scale with the PARENT's RSS, so
      // neither number means anything unquoted: measured on this route at
      // 4.16 ms per GET with the server at 134 MB RSS and 8.46 ms at 444 MB,
      // and going async removes 66% of that block at 134 MB but only 28% at
      // 444 MB. Re-measure on the host before quoting either figure.
      //
      // Async does not take the block to zero — `uv_spawn`'s fork/exec runs in
      // the parent, and no `child_process` API avoids it. Cheaper routes exist
      // and are rejected as not worth the machinery here rather than as
      // impossible: a worker thread spawns in 0.34 ms but costs a thread pool,
      // and reading `.git/HEAD` directly costs 0.05 ms but a hand-rolled ref
      // resolver covering packed-refs, `.git`-as-a-file worktrees, detached
      // HEAD and `core.abbrev`.
      headRev: await getHeadCommitAsync(target.root),
    };
  }),
);
