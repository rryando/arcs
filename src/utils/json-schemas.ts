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
  opencodeModelVariants: z
    .object({
      heavy: z.string(),
      standard: z.string(),
      light: z.string(),
    })
    .optional(),
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

export const syncStatsSchema = z
  .object({
    docsUpdated: z.number().int().min(0).optional(),
    knowledgeEntriesCreated: z.number().int().min(0).optional(),
    knowledgeEntriesUpdated: z.number().int().min(0).optional(),
    tasksTransitioned: z.number().int().min(0).optional(),
    plansUpdated: z.number().int().min(0).optional(),
    diagramsDrifted: z.number().int().min(0).optional(),
  })
  .passthrough();

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
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
});

// ---------------------------------------------------------------------------
// Code chunks — a captured line range in a workspace file
// ---------------------------------------------------------------------------

/** A `path:start-end` line range. `endLine` must not precede `startLine`. */
export const codeRefSchema = z
  .object({
    path: z.string().min(1),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    anchor: z.string().optional(),
  })
  .refine((ref) => ref.endLine >= ref.startLine, {
    message: "endLine must be greater than or equal to startLine",
    path: ["endLine"],
  });

/** A captured code slice: the range plus the text, optional language/revision. */
export const codeChunkSchema = z
  .object({
    path: z.string().min(1),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    language: z.string().optional(),
    snippet: z.string(),
    anchor: z.string().optional(),
    headRev: z.string().optional(),
    capturedAt: z.string(),
  })
  .refine((chunk) => chunk.endLine >= chunk.startLine, {
    message: "endLine must be greater than or equal to startLine",
    path: ["endLine"],
  });

/**
 * The completion-receipt pointer stored on a task or plan. Mirrors
 * `TaskReportRef` in `run-report.ts`; kept permissive so an older/newer
 * persisted pointer never fails a plan index rebuild.
 */
export const taskReportRefSchema = z.object({
  commit: z.string().optional(),
  branch: z.string().optional(),
  baseRef: z.string().optional(),
  url: z.string().optional(),
  filesChanged: z.number(),
  insertions: z.number(),
  deletions: z.number(),
  reportFile: z.string(),
  diffFile: z.string().optional(),
  truncated: z.boolean(),
  capturedAt: z.string(),
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
  report: taskReportRefSchema.optional(),
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
  codeChunks: z.array(codeChunkSchema).optional(),
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
// proposals/codegraph.json — codegraph ingestion proposals (gated, not direct-write)
// ---------------------------------------------------------------------------

export const proposalKindSchema = z.enum(["architecture", "module", "gotcha", "pattern"]);

export const proposalSchema = z.object({
  id: z.string(),
  kind: proposalKindSchema,
  label: z.string(),
  // Permissive for now; T007 will tighten the structuralFacts shape.
  structuralFacts: z.record(z.unknown()),
  sourceFiles: z.array(fileRefSchemaLocal),
  suggestedDedupCandidates: z.array(
    z.object({
      id: z.string(),
      overlap: z.array(z.string()),
    }),
  ),
});

export const proposalsFileSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  graphFingerprint: z.string(),
  proposals: z.array(proposalSchema),
});

// ---------------------------------------------------------------------------
// OpenCode ARCS bundle manifest (source bundle)
// ---------------------------------------------------------------------------

const configMergeSchema = z.object({
  path: z.array(z.string()),
  value: z.unknown().transform((v) => v as unknown),
  mode: z.enum(["overwrite", "if-absent", "merge"]).optional(),
});

export const agentTierSchema = z.enum(["heavy", "standard", "light"]);
export const agentStatusSchema = z.enum(["active", "retired"]);
export const agentKindSchema = z.enum(["primary", "subagent"]);
export const agentModeSchema = z.enum(["opencode", "claudecode", "pi"]);
const agentPermissionSchema = z.enum(["allow", "deny"]);

function isPromptPath(value: string): boolean {
  const segments = value.split("/");
  return (
    segments.length >= 2 &&
    segments[0] === "prompts" &&
    segments.slice(1).every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
    !value.includes("\\") &&
    (segments.at(-1)?.endsWith(".txt") ?? false)
  );
}

const agentPromptPathSchema = z
  .string()
  .refine(isPromptPath, "must be a safe relative .txt path under prompts/");

const piAgentPolicySchema = z.object({
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  extensions: z.array(z.string().min(1)).optional(),
  skills: z.array(z.string().min(1)).optional(),
});

export const agentRegistryRecordSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  status: agentStatusSchema,
  kind: agentKindSchema,
  tier: agentTierSchema,
  modes: z.array(agentModeSchema).min(1),
  source: agentPromptPathSchema,
  destination: agentPromptPathSchema,
  description: z.string().min(1),
  permissions: z.object({
    edit: agentPermissionSchema,
    bash: agentPermissionSchema,
    webfetch: agentPermissionSchema,
    mcp: agentPermissionSchema,
    task: agentPermissionSchema,
  }),
  pi: piAgentPolicySchema.optional(),
  replacementId: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),
});

export type AgentRegistryRecord = z.infer<typeof agentRegistryRecordSchema>;

export const opencodeSourceManifestSchema = z.object({
  bundleId: z.string(),
  installMode: z.string(),
  bundleVersionSource: z.string(),
  sourceRoot: z.string(),
  skills: z.object({
    source: z.string(),
    destination: z.string(),
  }),
  agents: z.array(agentRegistryRecordSchema),
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
  agents: z
    .array(
      z.object({
        id: z.string(),
        promptDestination: agentPromptPathSchema,
        sourceHash: z.string(),
        configKey: z.string().optional(),
        configHash: z.string().optional(),
      }),
    )
    .optional()
    .default([]),
});
