/**
 * Collection routes: knowledge, tasks, plans — full CRUD.
 *
 * All meta mutations go through the same locked, validated store functions the
 * CLI uses (knowledge-store / task-store / plan-store). Body .md files are
 * plain markdown and are read/written directly; meta file paths come from the
 * store indexes, never from client input.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { DagError } from "../../utils/errors.js";
import {
  createKnowledgeEntry,
  deleteKnowledgeEntry,
  KNOWLEDGE_AUDIENCES,
  KNOWLEDGE_KINDS,
  type KnowledgeMeta,
  readKnowledgeIndex,
  updateKnowledgeDocument,
} from "../../utils/knowledge-store.js";
import {
  createPlan,
  deletePlan,
  PLAN_STATUSES,
  type PlanMeta,
  readPlanIndex,
  updatePlanDocument,
} from "../../utils/plan-store.js";
import { normalizeIdentifier } from "../../utils/slug.js";
import {
  createTask,
  deleteTask,
  listTasks,
  TASK_PRIORITIES,
  TASK_STATUSES,
  updateTask,
} from "../../utils/task-store.js";
import { toposort } from "../../utils/toposort.js";
import { parseBody, requireProjectDir, respond } from "../respond.js";

export const collectionsRoute = new Hono();

// ---------------------------------------------------------------------------
// Shared zod pieces
// ---------------------------------------------------------------------------

const fileRefSchema = z.object({ path: z.string(), anchor: z.string().optional() });

async function readEntryBody(projectDir: string, file: string): Promise<string> {
  try {
    return await readFile(join(projectDir, file), "utf-8");
  } catch {
    return "";
  }
}

function findById<T extends { normalizedId: string }>(items: T[], rawId: string, what: string): T {
  const normalizedId = normalizeIdentifier(rawId);
  const item = items.find((i) => i.normalizedId === normalizedId);
  if (!item) {
    throw new DagError("ENTITY_NOT_FOUND", `${what} "${rawId}" not found`);
  }
  return item;
}

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

const createKnowledgeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(KNOWLEDGE_KINDS),
  audience: z.enum(KNOWLEDGE_AUDIENCES).optional(),
  keywords: z.array(z.string()).default([]),
  summary: z.string().optional(),
  content: z.string().optional(),
  sourceFiles: z.array(fileRefSchema).optional(),
});

const updateKnowledgeSchema = z.object({
  title: z.string().min(1).optional(),
  kind: z.enum(KNOWLEDGE_KINDS).optional(),
  audience: z.enum(KNOWLEDGE_AUDIENCES).nullable().optional(),
  keywords: z.array(z.string()).optional(),
  summary: z.string().optional(),
  sourceFiles: z.array(fileRefSchema).optional(),
  body: z.string().optional(),
});

collectionsRoute.get("/api/p/:slug/knowledge", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    const index = await readKnowledgeIndex(projectDir);
    return { entries: index.entries };
  }),
);

collectionsRoute.post("/api/p/:slug/knowledge", async (c) =>
  respond(
    c,
    async () => {
      const projectDir = requireProjectDir(c.req.param("slug"));
      const input = await parseBody(c, createKnowledgeSchema);
      return createKnowledgeEntry(projectDir, input);
    },
    201,
  ),
);

collectionsRoute.get("/api/p/:slug/knowledge/:id", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    const index = await readKnowledgeIndex(projectDir);
    const meta = findById<KnowledgeMeta>(index.entries, c.req.param("id"), "Knowledge entry");
    const body = await readEntryBody(projectDir, meta.file);
    return { meta, body };
  }),
);

collectionsRoute.patch("/api/p/:slug/knowledge/:id", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    const id = c.req.param("id");
    const input = await parseBody(c, updateKnowledgeSchema);
    const { body, audience, ...metaFields } = input;
    return updateKnowledgeDocument(projectDir, {
      id,
      ...metaFields,
      ...(audience !== undefined && { audience }),
      ...(body !== undefined && { content: body }),
    });
  }),
);

collectionsRoute.delete("/api/p/:slug/knowledge/:id", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    await deleteKnowledgeEntry(projectDir, c.req.param("id"));
    return { deleted: true };
  }),
);

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const createTaskSchema = z.object({
  title: z.string().min(1),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  planId: z.string().optional(),
  dependsOn: z.array(z.string()).optional(),
  sourceFiles: z.array(fileRefSchema).optional(),
  scope: z.string().optional(),
  acceptance: z.string().optional(),
  verify: z.string().optional(),
  skill: z.string().optional(),
  workMode: z.enum(["bounded", "inspect"]).optional(),
});

const updateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  planId: z.string().nullable().optional(),
  dependsOn: z.array(z.string()).nullable().optional(),
  sourceFiles: z.array(fileRefSchema).optional(),
  scope: z.string().nullable().optional(),
  acceptance: z.string().nullable().optional(),
  verify: z.string().nullable().optional(),
  skill: z.string().nullable().optional(),
  workMode: z.enum(["bounded", "inspect"]).nullable().optional(),
});

collectionsRoute.get("/api/p/:slug/tasks", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    const tasks = await listTasks(projectDir);

    let order: string[] | null = null;
    if (c.req.query("order") === "topo") {
      try {
        order = toposort(
          tasks.map((t) => ({ id: t.normalizedId, dependsOn: t.dependsOn, priority: t.priority })),
        );
      } catch {
        order = null;
      }
    }

    return { tasks, order };
  }),
);

collectionsRoute.post("/api/p/:slug/tasks", async (c) =>
  respond(
    c,
    async () => {
      const projectDir = requireProjectDir(c.req.param("slug"));
      const input = await parseBody(c, createTaskSchema);
      return createTask(projectDir, input);
    },
    201,
  ),
);

collectionsRoute.patch("/api/p/:slug/tasks/:id", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    const input = await parseBody(c, updateTaskSchema);
    return updateTask(projectDir, { id: c.req.param("id"), ...input });
  }),
);

collectionsRoute.delete("/api/p/:slug/tasks/:id", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    await deleteTask(projectDir, c.req.param("id"));
    return { deleted: true };
  }),
);

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

const createPlanSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(PLAN_STATUSES),
  keywords: z.array(z.string()).default([]),
  summary: z.string().optional(),
  content: z.string().optional(),
  sourceFiles: z.array(fileRefSchema).optional(),
});

const updatePlanSchema = z.object({
  title: z.string().min(1).optional(),
  status: z.enum(PLAN_STATUSES).optional(),
  keywords: z.array(z.string()).optional(),
  summary: z.string().optional(),
  sourceFiles: z.array(fileRefSchema).optional(),
  body: z.string().optional(),
  diagram: z.string().nullable().optional(),
});

collectionsRoute.get("/api/p/:slug/plans", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    const index = await readPlanIndex(projectDir);
    return { plans: index.plans };
  }),
);

collectionsRoute.post("/api/p/:slug/plans", async (c) =>
  respond(
    c,
    async () => {
      const projectDir = requireProjectDir(c.req.param("slug"));
      const input = await parseBody(c, createPlanSchema);
      return createPlan(projectDir, input);
    },
    201,
  ),
);

collectionsRoute.get("/api/p/:slug/plans/:id", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    const index = await readPlanIndex(projectDir);
    const meta = findById<PlanMeta>(index.plans, c.req.param("id"), "Plan");
    const body = await readEntryBody(projectDir, meta.file);

    let diagram: string | null = null;
    try {
      diagram = await readFile(
        join(projectDir, "plans", `${meta.normalizedId}.diagram.mmd`),
        "utf-8",
      );
    } catch {
      diagram = null;
    }

    return { meta, body, diagram };
  }),
);

collectionsRoute.patch("/api/p/:slug/plans/:id", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    const id = c.req.param("id");
    const input = await parseBody(c, updatePlanSchema);
    const { body, diagram, ...metaFields } = input;
    return updatePlanDocument(projectDir, {
      id,
      ...metaFields,
      ...(body !== undefined && { content: body }),
      ...(diagram !== undefined && { diagram }),
    });
  }),
);

collectionsRoute.delete("/api/p/:slug/plans/:id", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    await deletePlan(projectDir, c.req.param("id"));
    return { deleted: true };
  }),
);
