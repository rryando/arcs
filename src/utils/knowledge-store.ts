/**
 * Knowledge entry CRUD storage for ARCS projects.
 *
 * Provides create, update, delete, and index-read operations for knowledge
 * entries, with automatic index maintenance and rebuild-on-read resilience.
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { invalidateGraphCache } from "../retrieval/graph-invalidate.js";
import {
  indexRebuildFailed,
  invalidFileFormat,
  itemNotFound,
  normalizedIdCollision,
} from "./errors.js";
import { withLock } from "./file-lock.js";
import { readJsonSafe } from "./json.js";
import { knowledgeMetaSchema } from "./json-schemas.js";
import { normalizeIdentifier } from "./slug.js";
import {
  buildBody,
  ensureDir,
  fileExists,
  nowISO,
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
