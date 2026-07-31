/**
 * Plan CRUD storage for ARCS projects.
 *
 * Provides create, update, delete, and index-read operations for plans,
 * with automatic index maintenance and rebuild-on-read resilience.
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
import { planMetaSchema } from "./json-schemas.js";
import { normalizeIdentifier } from "./slug.js";
import {
  buildBody,
  ensureDir,
  fileExists,
  nowISO,
  sanitizeFileRefs,
  sanitizeKeywords,
  validatePlanStatus,
  writeFilesTransaction,
  writeJson,
} from "./storage-utils.js";

// ---------------------------------------------------------------------------
// Re-export types used by consumers
// ---------------------------------------------------------------------------

export type { FileRef, PlanStatus } from "./storage-utils.js";
export { PLAN_STATUSES } from "./storage-utils.js";

// ---------------------------------------------------------------------------
// Meta types
// ---------------------------------------------------------------------------

export interface PlanMeta {
  id: string;
  normalizedId: string;
  title: string;
  status: import("./storage-utils.js").PlanStatus;
  keywords: string[];
  summary: string;
  sourceFiles?: import("./storage-utils.js").FileRef[];
  file: string;
  createdAt: string;
  updatedAt: string;
}

interface PlanIndex {
  plans: PlanMeta[];
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreatePlanInput {
  id: string;
  title: string;
  status: import("./storage-utils.js").PlanStatus;
  keywords: string[];
  summary?: string;
  content?: string;
  sourceFiles?: import("./storage-utils.js").FileRef[];
  now?: string;
}

export interface UpdatePlanInput {
  id: string;
  status?: import("./storage-utils.js").PlanStatus;
  title?: string;
  summary?: string;
  keywords?: string[];
  sourceFiles?: import("./storage-utils.js").FileRef[];
  content?: string;
  diagram?: string | null;
  now?: string;
}

export interface PlanDocument {
  meta: PlanMeta;
  body: string;
  diagram: string | null;
}

// ---------------------------------------------------------------------------
// Index helpers
// ---------------------------------------------------------------------------

async function rebuildPlanIndex(plansDir: string): Promise<PlanIndex> {
  const files = (await readdir(plansDir)).filter((f) => f.endsWith(".meta.json"));
  const plans: PlanMeta[] = [];
  const errors: string[] = [];

  for (const file of files) {
    try {
      const filePath = join(plansDir, file);
      const raw = await readJsonSafe<unknown>(filePath);
      if (raw === undefined) {
        errors.push(file);
        continue;
      }
      const result = planMetaSchema.safeParse(raw);
      if (!result.success) {
        throw invalidFileFormat(
          filePath,
          result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "),
        );
      }
      plans.push(result.data as PlanMeta);
    } catch (e) {
      if (e instanceof Error && e.name === "DagError") throw e;
      errors.push(file);
    }
  }

  if (errors.length > 0) {
    throw indexRebuildFailed("plans", `corrupt meta files: ${errors.join(", ")}`);
  }

  const index: PlanIndex = { plans };
  await writeJson(join(plansDir, "index.json"), index);
  return index;
}

async function isPlanIndexStale(plansDir: string, index: PlanIndex): Promise<boolean> {
  const metaFiles = (await readdir(plansDir)).filter((f) => f.endsWith(".meta.json"));
  if (metaFiles.length !== index.plans.length) return true;

  for (const entry of index.plans) {
    const metaPath = join(plansDir, `${entry.normalizedId}.meta.json`);
    const diskMeta = await readJsonSafe<PlanMeta>(metaPath);
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

function planStoreLockPath(plansDir: string): string {
  return join(plansDir, ".store");
}

export async function createPlan(projectDir: string, input: CreatePlanInput): Promise<PlanMeta> {
  validatePlanStatus(input.status);
  const keywords = sanitizeKeywords(input.keywords);
  const sourceFiles = input.sourceFiles ? sanitizeFileRefs(input.sourceFiles) : undefined;
  const normalizedId = normalizeIdentifier(input.id);

  const plansDir = join(projectDir, "plans");
  await ensureDir(plansDir);

  return withLock(planStoreLockPath(plansDir), async () => {
    const metaPath = join(plansDir, `${normalizedId}.meta.json`);
    if (await fileExists(metaPath)) throw normalizedIdCollision("plan", input.id, normalizedId);

    const ts = nowISO(input.now);
    const bodyFile = join("plans", `${normalizedId}.md`);
    const bodyPath = join(projectDir, bodyFile);
    const indexPath = join(plansDir, "index.json");
    const meta: PlanMeta = {
      id: normalizedId,
      normalizedId,
      title: input.title,
      status: input.status,
      keywords,
      summary: input.summary ?? "",
      ...(sourceFiles && sourceFiles.length > 0 && { sourceFiles }),
      file: bodyFile,
      createdAt: ts,
      updatedAt: ts,
    };
    const index = (await readJsonSafe<PlanIndex>(indexPath)) ?? { plans: [] };
    index.plans.push(meta);

    await writeFilesTransaction([
      { path: metaPath, content: `${JSON.stringify(meta, null, 2)}\n` },
      { path: bodyPath, content: buildBody(input.title, input.content) },
      { path: indexPath, content: `${JSON.stringify(index, null, 2)}\n` },
    ]);
    invalidateGraphCache(basename(projectDir));
    return meta;
  });
}

async function updatePlanUnlocked(
  projectDir: string,
  input: UpdatePlanInput,
): Promise<PlanDocument> {
  const normalizedId = normalizeIdentifier(input.id);
  const plansDir = join(projectDir, "plans");
  const metaPath = join(plansDir, `${normalizedId}.meta.json`);

  const meta = await readJsonSafe<PlanMeta>(metaPath);
  if (!meta) {
    throw itemNotFound("plan", input.id);
  }

  const bodyPath = join(projectDir, meta.file);
  const diagramPath = join(plansDir, `${normalizedId}.diagram.mmd`);
  let body = await readFile(bodyPath, "utf-8").catch(() => "");
  let diagram = await readFile(diagramPath, "utf-8").catch(() => null);

  if (input.status !== undefined) meta.status = input.status;
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
  if (input.diagram !== undefined) {
    diagram = input.diagram === null || input.diagram.trim() === "" ? null : input.diagram;
  }
  meta.updatedAt = nowISO(input.now);

  const indexPath = join(plansDir, "index.json");
  const index = (await readJsonSafe<PlanIndex>(indexPath)) ?? { plans: [] };
  const idx = index.plans.findIndex((p) => p.normalizedId === normalizedId);
  if (idx >= 0) {
    index.plans[idx] = meta;
  } else {
    index.plans.push(meta);
  }
  const mutations: Array<{ path: string; content: string | null }> = [
    { path: metaPath, content: `${JSON.stringify(meta, null, 2)}\n` },
    { path: bodyPath, content: body },
    { path: indexPath, content: `${JSON.stringify(index, null, 2)}\n` },
  ];
  if (input.diagram !== undefined) mutations.push({ path: diagramPath, content: diagram });
  await writeFilesTransaction(mutations);

  invalidateGraphCache(basename(projectDir));
  return { meta, body, diagram };
}

async function updatePlanDocumentLocked(
  projectDir: string,
  input: UpdatePlanInput,
): Promise<PlanDocument> {
  if (input.status !== undefined) validatePlanStatus(input.status);
  const plansDir = join(projectDir, "plans");
  await ensureDir(plansDir);
  return withLock(planStoreLockPath(plansDir), () => updatePlanUnlocked(projectDir, input));
}

export async function updatePlan(projectDir: string, input: UpdatePlanInput): Promise<PlanMeta> {
  return (await updatePlanDocumentLocked(projectDir, input)).meta;
}

export async function updatePlanDocument(
  projectDir: string,
  input: UpdatePlanInput,
): Promise<PlanDocument> {
  return updatePlanDocumentLocked(projectDir, input);
}

export async function deletePlan(projectDir: string, id: string): Promise<void> {
  const normalizedId = normalizeIdentifier(id);
  const plansDir = join(projectDir, "plans");
  await ensureDir(plansDir);

  await withLock(planStoreLockPath(plansDir), async () => {
    const metaPath = join(plansDir, `${normalizedId}.meta.json`);
    const meta = await readJsonSafe<PlanMeta>(metaPath);
    if (!meta) throw itemNotFound("plan", id);

    const bodyPath = join(projectDir, meta.file);
    const diagramPath = join(plansDir, `${normalizedId}.diagram.mmd`);
    const indexPath = join(plansDir, "index.json");
    const index = (await readJsonSafe<PlanIndex>(indexPath)) ?? { plans: [] };
    index.plans = index.plans.filter((plan) => plan.normalizedId !== normalizedId);

    await writeFilesTransaction([
      { path: metaPath, content: null },
      { path: bodyPath, content: null },
      { path: diagramPath, content: null },
      { path: indexPath, content: `${JSON.stringify(index, null, 2)}\n` },
    ]);
    invalidateGraphCache(basename(projectDir));
  });
}

export async function readPlanIndex(projectDir: string): Promise<{ plans: PlanMeta[] }> {
  const plansDir = join(projectDir, "plans");

  if (!(await fileExists(plansDir))) {
    return { plans: [] };
  }

  const indexPath = join(plansDir, "index.json");
  const index = await readJsonSafe<PlanIndex>(indexPath);

  if (!index || !Array.isArray(index.plans)) {
    return rebuildPlanIndex(plansDir);
  }

  if (await isPlanIndexStale(plansDir, index)) {
    return rebuildPlanIndex(plansDir);
  }

  return index;
}
