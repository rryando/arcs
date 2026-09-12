/**
 * Knowledge entry CRUD storage for ARCS projects.
 *
 * Provides create, update, delete, and index-read operations for knowledge
 * entries, with automatic index maintenance and rebuild-on-read resilience.
 */

import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { invalidateGraphCache } from "../retrieval/graph-invalidate.js";
import { parseCodeRef, readCodeChunk } from "./code-snippet.js";
import {
  indexRebuildFailed,
  invalidFileFormat,
  itemNotFound,
  normalizedIdCollision,
} from "./errors.js";
import { withLock } from "./file-lock.js";
import { getHeadCommitAsync, isGitRepo } from "./git.js";
import { readJsonSafe } from "./json.js";
import { knowledgeMetaSchema } from "./json-schemas.js";
import { normalizeIdentifier } from "./slug.js";
import {
  buildBody,
  type CodeChunk,
  ensureDir,
  fileExists,
  nowISO,
  sanitizeCodeChunks,
  sanitizeFileRefs,
  sanitizeKeywords,
  validateKnowledgeKind,
  writeFilesTransaction,
  writeJson,
} from "./storage-utils.js";

// ---------------------------------------------------------------------------
// Re-export types used by consumers
// ---------------------------------------------------------------------------

export type { FileRef, KnowledgeAudience, KnowledgeKind } from "./storage-utils.js";
export { KNOWLEDGE_AUDIENCES, KNOWLEDGE_KINDS } from "./storage-utils.js";

// ---------------------------------------------------------------------------
// Meta types
// ---------------------------------------------------------------------------

export interface KnowledgeMeta {
  id: string;
  normalizedId: string;
  title: string;
  kind: import("./storage-utils.js").KnowledgeKind;
  audience?: import("./storage-utils.js").KnowledgeAudience;
  keywords: string[];
  summary: string;
  sourceFiles?: import("./storage-utils.js").FileRef[];
  file: string;
  createdAt: string;
  updatedAt: string;
  codeChunks?: import("./storage-utils.js").CodeChunk[];
}

interface KnowledgeIndex {
  entries: KnowledgeMeta[];
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreateKnowledgeInput {
  id: string;
  title: string;
  kind: import("./storage-utils.js").KnowledgeKind;
  audience?: import("./storage-utils.js").KnowledgeAudience;
  keywords: string[];
  summary?: string;
  content?: string;
  sourceFiles?: import("./storage-utils.js").FileRef[];
  codeChunks?: import("./storage-utils.js").CodeChunk[];
  now?: string;
}

export interface UpdateKnowledgeInput {
  id: string;
  title?: string;
  kind?: import("./storage-utils.js").KnowledgeKind;
  audience?: import("./storage-utils.js").KnowledgeAudience | null;
  summary?: string;
  keywords?: string[];
  sourceFiles?: import("./storage-utils.js").FileRef[];
  /**
   * Replaces the stored chunk list. `undefined` leaves it untouched; `[]`
   * clears it. Populate via `captureCodeChunks` so snippets are deterministic.
   */
  codeChunks?: import("./storage-utils.js").CodeChunk[];
  content?: string;
  now?: string;
}

export interface KnowledgeDocument {
  meta: KnowledgeMeta;
  body: string;
}

// ---------------------------------------------------------------------------
// Index helpers
// ---------------------------------------------------------------------------

async function rebuildKnowledgeIndex(knowledgeDir: string): Promise<KnowledgeIndex> {
  const files = (await readdir(knowledgeDir)).filter((f) => f.endsWith(".meta.json"));
  const entries: KnowledgeMeta[] = [];
  const errors: string[] = [];

  for (const file of files) {
    try {
      const filePath = join(knowledgeDir, file);
      const raw = await readJsonSafe<unknown>(filePath);
      if (raw === undefined) {
        errors.push(file);
        continue;
      }
      const result = knowledgeMetaSchema.safeParse(raw);
      if (!result.success) {
        throw invalidFileFormat(
          filePath,
          result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "),
        );
      }
      entries.push(result.data as KnowledgeMeta);
    } catch (e) {
      if (e instanceof Error && e.name === "DagError") throw e;
      errors.push(file);
    }
  }

  if (errors.length > 0) {
    throw indexRebuildFailed("knowledge", `corrupt meta files: ${errors.join(", ")}`);
  }

  const index: KnowledgeIndex = { entries };
  await writeJson(join(knowledgeDir, "index.json"), index);
  return index;
}

async function isKnowledgeIndexStale(
  knowledgeDir: string,
  index: KnowledgeIndex,
): Promise<boolean> {
  const metaFiles = (await readdir(knowledgeDir)).filter((f) => f.endsWith(".meta.json"));
  if (metaFiles.length !== index.entries.length) return true;

  for (const entry of index.entries) {
    const metaPath = join(knowledgeDir, `${entry.normalizedId}.meta.json`);
    const diskMeta = await readJsonSafe<KnowledgeMeta>(metaPath);
    if (!diskMeta || diskMeta.updatedAt !== entry.updatedAt) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Code-chunk capture
// ---------------------------------------------------------------------------

/**
 * Split a raw `--code` value into individual `path:start-end` refs. Comma is
 * safe as a separator because validated file paths cannot contain commas; the
 * CLI's arg parser collapses repeated flags, so a single comma-separated value
 * is how multiple chunks are supplied on one command line.
 */
export function splitCodeRefs(raw: string | undefined | string[]): string[] {
  if (raw === undefined) return [];
  const parts = Array.isArray(raw) ? raw : [raw];
  return parts
    .flatMap((part) => part.split(","))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Read every non-empty registered workspace path from `meta.json`, in order.
 * Whitespace-only entries (the shape a cleared path takes) are skipped rather
 * than treated as the filesystem root.
 */
async function readWorkspacePaths(projectDir: string): Promise<string[]> {
  const raw = await readJsonSafe<{ workspacePaths?: unknown }>(join(projectDir, "meta.json"));
  const paths = Array.isArray(raw?.workspacePaths) ? raw?.workspacePaths : [];
  const out: string[] = [];
  for (const candidate of paths) {
    if (typeof candidate === "string" && candidate.trim().length > 0) out.push(candidate);
  }
  return out;
}

/**
 * Resolve the project's workspace root, following the same convention as
 * `git-log`/`sync-agents-md`: read the first non-empty entry of
 * `workspacePaths` from the project's `meta.json`. Returns `null` when nothing
 * usable is registered — callers must not guess the CWD.
 *
 * For `--code` refs specifically, use {@link resolveCodeRefRoot} instead: it
 * adds the git-work-tree CWD as a first candidate so a plan worktree captures
 * the file it is actually editing.
 */
export async function resolveWorkspaceRoot(projectDir: string): Promise<string | null> {
  const paths = await readWorkspacePaths(projectDir);
  return paths[0] ?? null;
}

/**
 * Ordered roots a relative `--code` ref is resolved against. The current
 * working directory is a candidate only when it is inside a git work tree, so
 * a stray CWD (a home directory, `/`, a scratch dir that happens to share a
 * relative path) can never shadow the project's registered workspace; outside
 * a repo, only registered paths apply. Exact duplicates are collapsed while
 * preserving order.
 */
async function codeRefRootCandidates(projectDir: string): Promise<string[]> {
  const roots: string[] = [];
  let cwd: string | null = null;
  try {
    cwd = process.cwd();
  } catch {
    cwd = null;
  }
  if (cwd !== null && isGitRepo(cwd)) roots.push(cwd);
  for (const ws of await readWorkspacePaths(projectDir)) roots.push(ws);
  return [...new Set(roots)];
}

/**
 * True when `path` exists and is a readable regular file. Every probe failure
 * (ENOENT, EACCES, a directory, a stalled or unreadable mount) is a soft `false`
 * so one bad candidate root never aborts resolution or throws.
 */
async function isReadableCodeFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

/** Result of resolving a `--code` ref to the root that should read it. */
export interface CodeRefRootResolution {
  /** The first root whose `<root>/<refPath>` exists as a readable file, or `null`. */
  root: string | null;
  /** Every root that was tried, in order — used to report a clear failure. */
  tried: string[];
}

/**
 * Resolve a `--code` ref to the root that owns its file.
 *
 * Relative refs are tried in this documented order, stopping at the FIRST root
 * whose `<root>/<refPath>` exists as a readable file:
 *   1. the current working directory, but only when it is inside a git work
 *      tree (`isGitRepo(cwd)`);
 *   2. each registered `workspacePaths` entry from `meta.json`, in order.
 * The CWD is skipped outright outside a git work tree (and when
 * `process.cwd()` itself is unavailable). The registry fallback still applies
 * when the CWD is not a repo, so the git probe is a preference, not a hard
 * requirement.
 *
 * FILE-EXISTENCE RULE: root selection keys off the file existing, not off the
 * requested line range fitting. The first root that has the file wins even when
 * the range is past EOF there; capture then fails closed in `readCodeChunk`
 * rather than silently capturing a different revision from a later root.
 *
 * Absolute refs bypass resolution entirely and are handed to `readCodeChunk`
 * against the registered workspace root, exactly as before; `readCodeChunk`'s
 * in-root guard still applies.
 *
 * Never throws: a missing git CWD or an unreadable candidate root is skipped.
 */
export async function resolveCodeRefRoot(
  projectDir: string,
  refPath: string,
): Promise<CodeRefRootResolution> {
  if (isAbsolute(refPath)) {
    const registered = await resolveWorkspaceRoot(projectDir);
    return { root: registered, tried: registered === null ? [] : [registered] };
  }
  const tried = await codeRefRootCandidates(projectDir);
  for (const root of tried) {
    if (await isReadableCodeFile(join(root, refPath))) return { root, tried };
  }
  return { root: null, tried };
}

/** Discriminated result for deterministic chunk capture. */
export type CodeChunkCaptureResult =
  | { ok: true; chunks: CodeChunk[] }
  | { ok: false; code: string; message: string };

/**
 * Capture one chunk per `path:start-end` ref, deterministically and offline.
 *
 * Fails closed: any malformed ref, a ref no candidate root contains, or a ref
 * whose range cannot be read aborts the whole capture with a message that names
 * the offending value (and, when the file was not found, every root tried). On
 * success the caller persists `chunks` verbatim. Nothing is written before the
 * whole ref list captures successfully.
 *
 * A chunk's `path` is copied through from the caller's ref verbatim — a
 * relative ref stays relative, an absolute ref stays absolute.
 */
export async function captureCodeChunks(
  projectDir: string,
  refs: string[],
): Promise<CodeChunkCaptureResult> {
  if (refs.length === 0) return { ok: true, chunks: [] };

  const registeredCount = (await readWorkspacePaths(projectDir)).length;
  const headRevs = new Map<string, string | undefined>();
  const headRevFor = async (root: string): Promise<string | undefined> => {
    if (!headRevs.has(root)) {
      headRevs.set(root, (await getHeadCommitAsync(root)) ?? undefined);
    }
    return headRevs.get(root);
  };

  const chunks: CodeChunk[] = [];
  for (const raw of refs) {
    const ref = parseCodeRef(raw);
    if (!ref) {
      return {
        ok: false,
        code: "invalid_code_ref",
        message: `Invalid --code value "${raw}": expected "path:start-end" (e.g. src/x.ts:10-25).`,
      };
    }

    const resolution = await resolveCodeRefRoot(projectDir, ref.path);
    if (resolution.root === null) {
      // No candidate root has the file. With nothing registered to fall back
      // on, keep the established "register a workspace" guidance; otherwise name
      // every root that was tried so the caller can see where it looked.
      if (registeredCount === 0) {
        return {
          ok: false,
          code: "no_workspace_path",
          message:
            "Cannot capture --code chunks: project has no registered workspace path. " +
            "Register one with 'arcs project edit <slug> --workspace=<path>'.",
        };
      }
      return {
        ok: false,
        code: "code_chunk_unreadable",
        message: `Cannot capture --code "${raw}": not found under ${resolution.tried.join(", ")}.`,
      };
    }

    const headRev = await headRevFor(resolution.root);
    const chunk = await readCodeChunk(
      resolution.root,
      ref,
      headRev !== undefined ? { headRev } : undefined,
    );
    if (!chunk) {
      return {
        ok: false,
        code: "code_chunk_unreadable",
        message: `Cannot capture --code "${raw}": file "${ref.path}" is missing or lines ${ref.startLine}-${ref.endLine} are past EOF.`,
      };
    }
    chunks.push(chunk);
  }
  return { ok: true, chunks };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function rewriteBodyTitle(body: string, title: string): string {
  if (body.startsWith("# ")) {
    const newline = body.indexOf("\n");
    return newline === -1 ? `# ${title}\n` : `# ${title}${body.slice(newline)}`;
  }
  return `# ${title}\n\n${body}`;
}

function knowledgeStoreLockPath(knowledgeDir: string): string {
  return join(knowledgeDir, ".store");
}

export async function createKnowledgeEntry(
  projectDir: string,
  input: CreateKnowledgeInput,
): Promise<KnowledgeMeta> {
  validateKnowledgeKind(input.kind);
  const keywords = sanitizeKeywords(input.keywords);
  const sourceFiles = input.sourceFiles ? sanitizeFileRefs(input.sourceFiles) : undefined;
  const codeChunks = input.codeChunks ? sanitizeCodeChunks(input.codeChunks) : undefined;
  const normalizedId = normalizeIdentifier(input.id);

  const knowledgeDir = join(projectDir, "knowledge");
  await ensureDir(knowledgeDir);

  return withLock(knowledgeStoreLockPath(knowledgeDir), async () => {
    const metaPath = join(knowledgeDir, `${normalizedId}.meta.json`);
    if (await fileExists(metaPath)) {
      throw normalizedIdCollision("knowledge entry", input.id, normalizedId);
    }

    const ts = nowISO(input.now);
    const bodyFile = join("knowledge", `${normalizedId}.md`);
    const bodyPath = join(projectDir, bodyFile);
    const indexPath = join(knowledgeDir, "index.json");
    const meta: KnowledgeMeta = {
      id: normalizedId,
      normalizedId,
      title: input.title,
      kind: input.kind,
      ...(input.audience && { audience: input.audience }),
      keywords,
      summary: input.summary ?? "",
      ...(sourceFiles && sourceFiles.length > 0 && { sourceFiles }),
      ...(codeChunks && codeChunks.length > 0 && { codeChunks }),
      file: bodyFile,
      createdAt: ts,
      updatedAt: ts,
    };
    const index = (await readJsonSafe<KnowledgeIndex>(indexPath)) ?? { entries: [] };
    index.entries.push(meta);

    await writeFilesTransaction([
      { path: metaPath, content: `${JSON.stringify(meta, null, 2)}\n` },
      { path: bodyPath, content: buildBody(input.title, input.content) },
      { path: indexPath, content: `${JSON.stringify(index, null, 2)}\n` },
    ]);

    invalidateGraphCache(basename(projectDir));
    return meta;
  });
}

async function updateKnowledgeEntryUnlocked(
  projectDir: string,
  input: UpdateKnowledgeInput,
): Promise<KnowledgeDocument> {
  const normalizedId = normalizeIdentifier(input.id);
  const knowledgeDir = join(projectDir, "knowledge");
  const metaPath = join(knowledgeDir, `${normalizedId}.meta.json`);

  const meta = await readJsonSafe<KnowledgeMeta>(metaPath);
  if (!meta) {
    throw itemNotFound("knowledge entry", input.id);
  }

  const bodyPath = join(projectDir, meta.file);
  let body = await readFile(bodyPath, "utf-8").catch(() => "");

  if (input.kind !== undefined) meta.kind = input.kind;
  if (input.audience !== undefined) {
    if (input.audience === null) {
      delete meta.audience;
    } else {
      meta.audience = input.audience;
    }
  }
  if (input.title !== undefined && input.title !== meta.title) {
    if (input.content === undefined) body = rewriteBodyTitle(body, input.title);
    meta.title = input.title;
  }
  if (input.summary !== undefined) meta.summary = input.summary;
  if (input.keywords !== undefined) meta.keywords = sanitizeKeywords(input.keywords);
  if (input.sourceFiles !== undefined) {
    if (input.sourceFiles.length === 0) {
      delete meta.sourceFiles;
    } else {
      meta.sourceFiles = sanitizeFileRefs(input.sourceFiles);
    }
  }
  if (input.codeChunks !== undefined) {
    if (input.codeChunks.length === 0) {
      delete meta.codeChunks;
    } else {
      meta.codeChunks = sanitizeCodeChunks(input.codeChunks);
    }
  }
  if (input.content !== undefined) body = input.content;
  meta.updatedAt = nowISO(input.now);
  const indexPath = join(knowledgeDir, "index.json");
  const index = (await readJsonSafe<KnowledgeIndex>(indexPath)) ?? { entries: [] };
  const idx = index.entries.findIndex((e) => e.normalizedId === normalizedId);
  if (idx >= 0) {
    index.entries[idx] = meta;
  } else {
    index.entries.push(meta);
  }

  await writeFilesTransaction([
    { path: metaPath, content: `${JSON.stringify(meta, null, 2)}\n` },
    { path: bodyPath, content: body },
    { path: indexPath, content: `${JSON.stringify(index, null, 2)}\n` },
  ]);

  invalidateGraphCache(basename(projectDir));
  return { meta, body };
}

async function updateKnowledgeDocumentLocked(
  projectDir: string,
  input: UpdateKnowledgeInput,
): Promise<KnowledgeDocument> {
  if (input.kind !== undefined) validateKnowledgeKind(input.kind);
  const knowledgeDir = join(projectDir, "knowledge");
  await ensureDir(knowledgeDir);
  return withLock(knowledgeStoreLockPath(knowledgeDir), () =>
    updateKnowledgeEntryUnlocked(projectDir, input),
  );
}

export async function updateKnowledgeEntry(
  projectDir: string,
  input: UpdateKnowledgeInput,
): Promise<KnowledgeMeta> {
  return (await updateKnowledgeDocumentLocked(projectDir, input)).meta;
}

export async function updateKnowledgeDocument(
  projectDir: string,
  input: UpdateKnowledgeInput,
): Promise<KnowledgeDocument> {
  return updateKnowledgeDocumentLocked(projectDir, input);
}

export async function deleteKnowledgeEntry(projectDir: string, id: string): Promise<void> {
  const normalizedId = normalizeIdentifier(id);
  const knowledgeDir = join(projectDir, "knowledge");
  await ensureDir(knowledgeDir);

  await withLock(knowledgeStoreLockPath(knowledgeDir), async () => {
    const metaPath = join(knowledgeDir, `${normalizedId}.meta.json`);
    const meta = await readJsonSafe<KnowledgeMeta>(metaPath);
    if (!meta) throw itemNotFound("knowledge entry", id);

    const bodyPath = join(projectDir, meta.file);
    const indexPath = join(knowledgeDir, "index.json");
    const index = (await readJsonSafe<KnowledgeIndex>(indexPath)) ?? { entries: [] };
    index.entries = index.entries.filter((entry) => entry.normalizedId !== normalizedId);

    await writeFilesTransaction([
      { path: metaPath, content: null },
      { path: bodyPath, content: null },
      { path: indexPath, content: `${JSON.stringify(index, null, 2)}\n` },
    ]);
    invalidateGraphCache(basename(projectDir));
  });
}

export async function readKnowledgeIndex(
  projectDir: string,
): Promise<{ entries: KnowledgeMeta[] }> {
  const knowledgeDir = join(projectDir, "knowledge");

  if (!(await fileExists(knowledgeDir))) {
    return { entries: [] };
  }

  const indexPath = join(knowledgeDir, "index.json");
  const index = await readJsonSafe<KnowledgeIndex>(indexPath);

  if (!index || !Array.isArray(index.entries)) {
    return rebuildKnowledgeIndex(knowledgeDir);
  }

  if (await isKnowledgeIndexStale(knowledgeDir, index)) {
    return rebuildKnowledgeIndex(knowledgeDir);
  }

  return index;
}
