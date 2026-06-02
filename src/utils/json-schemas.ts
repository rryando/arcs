/**
 * Zod schemas for JSON file shapes used at file-read boundaries.
 * Kept separate from schemas.ts (which holds tool-input schemas).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// package.json (only fields ARCS reads)
// ---------------------------------------------------------------------------

export const packageJsonSchema = z.object({
  name: z.string().optional(),
  version: z.string(),
});

export type PackageJson = z.infer<typeof packageJsonSchema>;

// ---------------------------------------------------------------------------
// ~/.arcs/config.json
// ---------------------------------------------------------------------------

export const cliConfigSchema = z.object({
  version: z.literal("1"),
  ides: z.array(z.string()),
});

export type CliConfig = z.infer<typeof cliConfigSchema>;

// ---------------------------------------------------------------------------
// DAG root meta.json
// ---------------------------------------------------------------------------

export const dagNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  dependsOn: z.array(z.string()),
});

export const rootMetaSchema = z.object({
  version: z.string(),
  projects: z.array(dagNodeSchema),
});

export type RootMetaJson = z.infer<typeof rootMetaSchema>;

// ---------------------------------------------------------------------------
// Per-project meta.json
// ---------------------------------------------------------------------------

export const syncStatsSchema = z.object({
  docsUpdated: z.number().int().min(0),
  knowledgeEntriesCreated: z.number().int().min(0),
  knowledgeEntriesUpdated: z.number().int().min(0),
  tasksTransitioned: z.number().int().min(0),
  plansUpdated: z.number().int().min(0),
  diagramsDrifted: z.number().int().min(0),
});

export type SyncStats = z.infer<typeof syncStatsSchema>;

export const projectMetaSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    status: z.string().optional(),
    repoUrl: z.string().optional(),
    createdAt: z.string(),
    workspacePaths: z.array(z.string()).optional().default([]),
    lastSyncedAt: z.string().datetime().optional(),
    lastSyncGitCommit: z.string().optional(),
    lastSyncStats: syncStatsSchema.optional(),
  })
  .passthrough();

export type ProjectMetaJson = z.infer<typeof projectMetaSchema>;

// ---------------------------------------------------------------------------
// plans/index.json, knowledge/index.json, tasks/index.json
// ---------------------------------------------------------------------------

const fileRefSchemaLocal = z.object({
  path: z.string(),
  anchor: z.string().optional(),
});

export const planMetaSchema = z.object({
  id: z.string(),
  normalizedId: z.string(),
  title: z.string(),
  status: z.string(),
  keywords: z.array(z.string()),
  summary: z.string(),
  sourceFiles: z.array(fileRefSchemaLocal).optional(),
  file: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const planIndexSchema = z.object({
  plans: z.array(planMetaSchema),
});

export const knowledgeMetaSchema = z.object({
  id: z.string(),
  normalizedId: z.string(),
  title: z.string(),
  kind: z.string(),
  audience: z.string().optional(),
  keywords: z.array(z.string()),
  summary: z.string(),
  sourceFiles: z.array(fileRefSchemaLocal).optional(),
  file: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const knowledgeIndexSchema = z.object({
  entries: z.array(knowledgeMetaSchema),
});

export const taskMetaSchema = z.object({
  id: z.string(),
  normalizedId: z.string(),
  title: z.string(),
  status: z.string(),
  priority: z.string(),
  sourceFiles: z.array(fileRefSchemaLocal).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const taskIndexSchema = z.object({
  tasks: z.array(taskMetaSchema),
});

// ---------------------------------------------------------------------------
// OpenCode ARCS bundle manifest (source bundle)
// ---------------------------------------------------------------------------

const configMergeSchema = z.object({
  path: z.array(z.string()),
  value: z.unknown().transform((v) => v as unknown),
  mode: z.enum(["overwrite", "if-absent"]).optional(),
});

export const opencodeSourceManifestSchema = z.object({
  bundleId: z.string(),
  installMode: z.string(),
  bundleVersionSource: z.string(),
  sourceRoot: z.string(),
  skills: z.object({
    source: z.string(),
    destination: z.string(),
  }),
  agents: z.array(
    z.object({
      source: z.string(),
      destination: z.string(),
    }),
  ),
  ownedPaths: z.array(z.string()),
  plugin: z.object({
    required: z.boolean(),
    source: z.string(),
    destination: z.string(),
  }),
  config: z.object({
    requiredMerges: z.array(configMergeSchema),
  }),
});

export const opencodeInstalledManifestSchema = z.object({
  bundleId: z.string(),
  installMode: z.string(),
  sourceBundleVersion: z.string(),
  sourceBundleHash: z.string(),
  installedAt: z.string(),
  ownedPaths: z.array(z.string()),
});
