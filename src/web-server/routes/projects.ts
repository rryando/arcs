/**
 * Project-level routes: project listing, docs, cross-project graph,
 * flat search index, and root DAG dependency edits.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { readRootMeta, validateDependencies, wouldCreateCycle } from "../../utils/dag.js";
import { DagError } from "../../utils/errors.js";
import { readJsonSafe } from "../../utils/json.js";
import type { ProjectMetaJson } from "../../utils/json-schemas.js";
import { readKnowledgeIndex } from "../../utils/knowledge-store.js";
import { getDataDir, getProjectDir } from "../../utils/paths.js";
import { readPlanIndex } from "../../utils/plan-store.js";
import { PROJECT_DOC_FILES, type ProjectDocType } from "../../utils/project-documents.js";
import { readProposals } from "../../utils/proposal-store.js";
import { listTasks } from "../../utils/task-store.js";
import { assertProjectSlug, parseBody, requireProjectDir, respond } from "../respond.js";
import {
  mutateRootMetaLocked,
  withFileLocks,
  writeTextAtomic,
  writeTextLocked,
} from "../storage.js";
import { countPendingProposalDocs } from "./proposal-docs.js";

export const projectsRoute = new Hono();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ProjectCounts {
  knowledge: number;
  tasks: number;
  plans: number;
  proposals: number;
  proposalDocs: number;
}

async function projectCounts(slug: string): Promise<ProjectCounts> {
  const projectDir = getProjectDir(slug);
  const [knowledge, tasks, plans, proposalFile, proposalDocs] = await Promise.all([
    readKnowledgeIndex(projectDir)
      .then((i) => i.entries.length)
      .catch(() => 0),
    listTasks(projectDir)
      .then((t) => t.length)
      .catch(() => 0),
    readPlanIndex(projectDir)
      .then((i) => i.plans.length)
      .catch(() => 0),
    readProposals(slug).catch(() => null),
    countPendingProposalDocs(projectDir).catch(() => 0),
  ]);

  return {
    knowledge,
    tasks,
    plans,
    proposals: proposalFile?.proposals.length ?? 0,
    proposalDocs,
  };
}

// ---------------------------------------------------------------------------
// GET /api/projects — root DAG + per-project meta + counts
// ---------------------------------------------------------------------------

projectsRoute.get("/api/projects", async (c) =>
  respond(c, async () => {
    const dataDir = getDataDir();
    const rootMeta = await readRootMeta(dataDir);

    const projects = await Promise.all(
      rootMeta.projects.map(async (node) => {
        const projectDir = getProjectDir(node.id);
        const meta = await readJsonSafe<ProjectMetaJson>(join(projectDir, "meta.json"));
        const counts = await projectCounts(node.id);
        return {
          slug: node.id,
          name: meta?.name ?? node.name,
          description: meta?.description ?? "",
          status: meta?.status ?? node.status,
          dependsOn: node.dependsOn,
          workspacePaths: meta?.workspacePaths ?? [],
          createdAt: meta?.createdAt ?? null,
          lastSyncedAt: meta?.lastSyncedAt ?? null,
          counts,
        };
      }),
    );

    projects.sort((a, b) => a.name.localeCompare(b.name));
    return { projects };
  }),
);

// ---------------------------------------------------------------------------
// GET /api/graph — cross-project DAG
// ---------------------------------------------------------------------------

projectsRoute.get("/api/graph", async (c) =>
  respond(c, async () => {
    const rootMeta = await readRootMeta(getDataDir());
    const nodes = rootMeta.projects.map((p) => ({
      id: `project:${p.id}`,
      type: "project" as const,
      title: p.name,
      status: p.status,
      slug: p.id,
    }));
    const edges = rootMeta.projects.flatMap((p) =>
      p.dependsOn.map((dep) => ({
        source: `project:${p.id}`,
        target: `project:${dep}`,
        relation: "project_depends_on" as const,
        weight: 0.3,
      })),
    );
    return { nodes, edges };
  }),
);

// ---------------------------------------------------------------------------
// GET /api/index — flat searchable index across all projects (command palette)
// ---------------------------------------------------------------------------

interface FlatEntry {
  type: "project" | "knowledge" | "plan" | "task";
  slug: string;
  id: string;
  title: string;
  keywords: string[];
  hint: string;
}

projectsRoute.get("/api/index", async (c) =>
  respond(c, async () => {
    const dataDir = getDataDir();
    const rootMeta = await readRootMeta(dataDir);
    const entries: FlatEntry[] = [];

    for (const node of rootMeta.projects) {
      const projectDir = getProjectDir(node.id);
      const meta = await readJsonSafe<ProjectMetaJson>(join(projectDir, "meta.json"));
      const name = meta?.name ?? node.name;

      entries.push({
        type: "project",
        slug: node.id,
        id: node.id,
        title: name,
        keywords: [],
        hint: meta?.status ?? node.status,
      });

      const [knowledge, plans, tasks] = await Promise.all([
        readKnowledgeIndex(projectDir).catch(() => ({ entries: [] })),
        readPlanIndex(projectDir).catch(() => ({ plans: [] })),
        listTasks(projectDir).catch(() => []),
      ]);

      for (const entry of knowledge.entries) {
        entries.push({
          type: "knowledge",
          slug: node.id,
          id: entry.normalizedId,
          title: entry.title,
          keywords: entry.keywords,
          hint: entry.kind,
        });
      }
      for (const plan of plans.plans) {
        entries.push({
          type: "plan",
          slug: node.id,
          id: plan.normalizedId,
          title: plan.title,
          keywords: plan.keywords,
          hint: plan.status,
        });
      }
      for (const task of tasks) {
        entries.push({
          type: "task",
          slug: node.id,
          id: task.normalizedId,
          title: task.title,
          keywords: [],
          hint: `${task.status} · ${task.priority}`,
        });
      }
    }

    return {
      entries,
      projectName: Object.fromEntries(rootMeta.projects.map((p) => [p.id, p.name])),
    };
  }),
);

// ---------------------------------------------------------------------------
// GET /api/p/:slug — single project detail
// ---------------------------------------------------------------------------

projectsRoute.get("/api/p/:slug", async (c) =>
  respond(c, async () => {
    const slug = c.req.param("slug");
    const projectDir = requireProjectDir(slug);
    const meta = await readJsonSafe<ProjectMetaJson>(join(projectDir, "meta.json"));
    const counts = await projectCounts(slug);
    const rootMeta = await readRootMeta(getDataDir());
    const node = rootMeta.projects.find((p) => p.id === slug);

    return {
      slug,
      name: meta?.name ?? slug,
      description: meta?.description ?? "",
      status: meta?.status ?? node?.status ?? "unknown",
      repoUrl: meta?.repoUrl ?? null,
      dependsOn: node?.dependsOn ?? [],
      workspacePaths: meta?.workspacePaths ?? [],
      createdAt: meta?.createdAt ?? null,
      lastSyncedAt: meta?.lastSyncedAt ?? null,
      counts,
    };
  }),
);

const updateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.string().min(1).optional(),
  repoUrl: z.string().url().nullable().optional(),
  workspacePaths: z.array(z.string().min(1)).optional(),
});

projectsRoute.patch("/api/p/:slug", async (c) =>
  respond(c, async () => {
    const slug = c.req.param("slug");
    const projectDir = requireProjectDir(slug);
    const input = await parseBody(c, updateProjectSchema);
    const metaPath = join(projectDir, "meta.json");
    const dataDir = getDataDir();
    const rootMetaPath = join(dataDir, "meta.json");

    return withFileLocks([rootMetaPath, metaPath], async () => {
      const meta = await readJsonSafe<Record<string, unknown>>(metaPath);
      if (!meta) {
        throw new DagError("PROJECT_NOT_FOUND", `Project "${slug}" not found`);
      }
      const rootMeta = await readRootMeta(dataDir);
      const node = rootMeta.projects.find((project) => project.id === slug);
      if (!node) {
        throw new DagError("PROJECT_NOT_FOUND", `Project "${slug}" not found`);
      }

      const updated = { ...meta, ...input };
      if (input.repoUrl === null) delete updated.repoUrl;
      if (input.name !== undefined) node.name = input.name;
      if (input.status !== undefined) node.status = input.status;

      const originalMetaContent = `${JSON.stringify(meta, null, 2)}\n`;
      await writeTextAtomic(metaPath, `${JSON.stringify(updated, null, 2)}\n`);
      try {
        await writeTextAtomic(rootMetaPath, `${JSON.stringify(rootMeta, null, 2)}\n`);
      } catch (error) {
        await writeTextAtomic(metaPath, originalMetaContent).catch(() => {});
        throw error;
      }

      return { slug, ...updated, dependsOn: node.dependsOn };
    });
  }),
);

// ---------------------------------------------------------------------------
// GET|PUT /api/p/:slug/docs/:doc — project documents (overview.md etc.)
// ---------------------------------------------------------------------------

function parseDocType(raw: string): ProjectDocType {
  if (!(raw in PROJECT_DOC_FILES)) {
    throw new DagError(
      "INVALID_DOC_TYPE",
      `Invalid document type "${raw}". Valid: ${Object.keys(PROJECT_DOC_FILES).join(", ")}`,
    );
  }
  return raw as ProjectDocType;
}

projectsRoute.get("/api/p/:slug/docs/:doc", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    const doc = parseDocType(c.req.param("doc"));
    const filePath = join(projectDir, PROJECT_DOC_FILES[doc]);
    try {
      const content = await readFile(filePath, "utf-8");
      return { doc, content, exists: true };
    } catch {
      return { doc, content: "", exists: false };
    }
  }),
);

const updateDocSchema = z.object({ content: z.string() });

projectsRoute.put("/api/p/:slug/docs/:doc", async (c) =>
  respond(c, async () => {
    const projectDir = requireProjectDir(c.req.param("slug"));
    const doc = parseDocType(c.req.param("doc"));
    const { content } = await parseBody(c, updateDocSchema);
    const filePath = join(projectDir, PROJECT_DOC_FILES[doc]);
    await writeTextLocked(filePath, content);
    return { doc, updated: true };
  }),
);

// ---------------------------------------------------------------------------
// POST /api/projects/:slug/dependencies — add/remove root DAG edges
// ---------------------------------------------------------------------------

const dependenciesSchema = z.object({
  add: z.array(z.string()).optional(),
  remove: z.array(z.string()).optional(),
});

projectsRoute.post("/api/projects/:slug/dependencies", async (c) =>
  respond(c, async () => {
    const slug = c.req.param("slug");
    assertProjectSlug(slug);
    const { add = [], remove = [] } = await parseBody(c, dependenciesSchema);

    const dataDir = getDataDir();
    return mutateRootMetaLocked(dataDir, (rootMeta) => {
      const project = rootMeta.projects.find((entry) => entry.id === slug);
      if (!project) {
        throw new DagError("PROJECT_NOT_FOUND", `Project "${slug}" not found`);
      }

      const unknown = validateDependencies(rootMeta.projects, [...add, ...remove]);
      if (unknown.length > 0) {
        throw new DagError(
          "DEPENDENCY_NOT_FOUND",
          `Unknown dependency target(s): ${unknown.join(", ")}`,
        );
      }

      for (const target of add) {
        if (target === slug) {
          throw new DagError("SELF_DEPENDENCY", "A project cannot depend on itself");
        }
        if (
          !project.dependsOn.includes(target) &&
          wouldCreateCycle(rootMeta.projects, slug, target)
        ) {
          throw new DagError(
            "CYCLE_DETECTED",
            `Adding dependency "${slug}" → "${target}" would create a cycle.`,
          );
        }
      }

      project.dependsOn = [
        ...project.dependsOn.filter((dependency) => !remove.includes(dependency)),
        ...add.filter((dependency) => !project.dependsOn.includes(dependency)),
      ];

      return { slug, dependsOn: project.dependsOn };
    });
  }),
);
