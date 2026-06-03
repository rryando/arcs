// ---------------------------------------------------------------------------
// Project update commands — update-doc, update-status, update-paths, write-checkpoint
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readRootMeta, writeRootMeta } from "../../utils/dag.js";
import { getDataDir, getProjectDir } from "../../utils/paths.js";
import { PROJECT_DOC_FILES, type ProjectDocType } from "../../utils/project-documents.js";
import { normalizeWorkspacePath } from "../../utils/workspace-match.js";
import {
  type CLIResult,
  type CommandFlags,
  defineCommand,
  ERROR_CODES,
  type ParamDef,
  type ParsedParams,
} from "../command-registry.js";
import { failure, success } from "../output-envelope.js";

// ---------------------------------------------------------------------------
// project update-doc
// ---------------------------------------------------------------------------

const projectUpdateDocParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
  doc: {
    type: "string",
    required: true,
    positional: 1,
    description: "Document to update",
    enum: ["overview", "tasks", "dependencies", "knowledge"],
  },
  "body-file": { type: "string", description: "Path to file with new doc content" },
  "body-stdin": { type: "boolean", description: "Read content from stdin" },
  content: { type: "string", required: false, description: "Inline document content" },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "project update-doc",
  description: "Update a project document",
  mutation: true,
  params: projectUpdateDocParams,
  handler: handleProjectUpdateDoc,
});

async function handleProjectUpdateDoc(
  params: ParsedParams<typeof projectUpdateDocParams>,
  flags: CommandFlags,
): Promise<CLIResult> {
  const slug = params.slug;
  const doc: ProjectDocType = params.doc;
  const bodyFile = params["body-file"];
  const bodyStdin = params["body-stdin"];
  const inlineContent = params.content;

  const validDocs = Object.keys(PROJECT_DOC_FILES);
  if (!validDocs.includes(doc)) {
    return failure(
      ERROR_CODES.INVALID_ENUM,
      `Invalid doc type "${doc}". Valid: ${validDocs.join(", ")}`,
    );
  }

  const projectDir = getProjectDir(slug);
  if (!existsSync(projectDir)) {
    return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`);
  }

  if (!bodyFile && !inlineContent && !bodyStdin) {
    return failure(
      ERROR_CODES.MISSING_PARAM,
      "Either --body-file, --content, or --body-stdin is required",
      {
        param: "body-file",
      },
    );
  }

  if (flags.dryRun) {
    return success({ dryRun: true, wouldUpdate: { slug, doc, bodyFile, inlineContent } });
  }

  let content: string;
  if (bodyFile) {
    if (!existsSync(bodyFile)) {
      return failure(ERROR_CODES.ENTITY_NOT_FOUND, `Body file not found: ${bodyFile}`);
    }
    content = readFileSync(bodyFile, "utf-8");
  } else if (inlineContent !== undefined) {
    content = inlineContent;
  } else {
    // Read from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    content = Buffer.concat(chunks).toString("utf-8");
  }

  const fileName = PROJECT_DOC_FILES[doc];
  const filePath = resolve(projectDir, fileName);

  try {
    await writeFile(filePath, content, "utf-8");
    return success({ updated: true, slug, doc, path: filePath });
  } catch (err) {
    return failure("write_error", err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// project update-status
// ---------------------------------------------------------------------------

const projectUpdateStatusParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
  status: {
    type: "string",
    required: true,
    positional: 1,
    description: "New status",
    enum: ["active", "paused", "completed", "archived"],
  },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "project update-status",
  description: "Update a project's status",
  mutation: true,
  params: projectUpdateStatusParams,
  handler: handleProjectUpdateStatus,
});

async function handleProjectUpdateStatus(
  params: ParsedParams<typeof projectUpdateStatusParams>,
  flags: CommandFlags,
): Promise<CLIResult> {
  const slug = params.slug;
  const status = params.status;

  if (flags.dryRun) {
    return success({ dryRun: true, wouldUpdate: { slug, status } });
  }

  const dataDir = getDataDir();
  try {
    const rootMeta = await readRootMeta(dataDir);
    const project = rootMeta.projects.find((p) => p.id === slug);
    if (!project) {
      return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`);
    }

    const oldStatus = project.status;
    project.status = status;
    await writeRootMeta(dataDir, rootMeta);

    return success({ slug, previousStatus: oldStatus, newStatus: status });
  } catch (err) {
    return failure("update_error", err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// project update-paths
// ---------------------------------------------------------------------------

const projectUpdatePathsParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
  add: { type: "string", description: "Path to add to workspace paths" },
  remove: { type: "string", description: "Path to remove from workspace paths" },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "project update-paths",
  description: "Add or remove workspace paths for a project",
  mutation: true,
  params: projectUpdatePathsParams,
  handler: handleProjectUpdatePaths,
});

async function handleProjectUpdatePaths(
  params: ParsedParams<typeof projectUpdatePathsParams>,
  flags: CommandFlags,
): Promise<CLIResult> {
  const slug = params.slug;
  const addPath = params.add;
  const removePath = params.remove;

  if (!addPath && !removePath) {
    return failure(ERROR_CODES.MISSING_PARAM, "Either --add or --remove is required", {
      param: "add",
    });
  }

  const projectDir = getProjectDir(slug);
  if (!existsSync(projectDir)) {
    return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`);
  }

  if (flags.dryRun) {
    return success({ dryRun: true, wouldUpdate: { slug, add: addPath, remove: removePath } });
  }

  const metaPath = resolve(projectDir, "meta.json");
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    const paths: string[] = meta.workspacePaths ?? [];

    if (addPath) {
      const normalized = normalizeWorkspacePath(addPath);
      if (!paths.includes(normalized)) {
        paths.push(normalized);
      }
    }

    if (removePath) {
      const normalized = normalizeWorkspacePath(removePath);
      const idx = paths.indexOf(normalized);
      if (idx >= 0) {
        paths.splice(idx, 1);
      }
    }

    meta.workspacePaths = paths;
    await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");

    return success({ slug, workspacePaths: paths });
  } catch (err) {
    return failure("update_error", err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// project write-checkpoint
// ---------------------------------------------------------------------------

const projectWriteCheckpointParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
  lastSyncedAt: { type: "string", description: "ISO timestamp of last sync" },
  lastSyncGitCommit: { type: "string", description: "Git commit SHA of last sync" },
  lastSyncStats: { type: "string", description: "JSON string with sync stats object" },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "project write-checkpoint",
  description:
    "Write sync checkpoint fields (lastSyncedAt, lastSyncGitCommit, lastSyncStats) to project meta.json",
  mutation: true,
  params: projectWriteCheckpointParams,
  handler: handleProjectWriteCheckpoint,
});

async function handleProjectWriteCheckpoint(
  params: ParsedParams<typeof projectWriteCheckpointParams>,
  flags: CommandFlags,
): Promise<CLIResult> {
  const slug = params.slug;
  const lastSyncedAt = params.lastSyncedAt;
  const lastSyncGitCommit = params.lastSyncGitCommit;
  const lastSyncStatsRaw = params.lastSyncStats;

  if (!lastSyncedAt && !lastSyncGitCommit && !lastSyncStatsRaw) {
    return failure(
      ERROR_CODES.MISSING_PARAM,
      "At least one of --lastSyncedAt, --lastSyncGitCommit, or --lastSyncStats is required",
      { param: "lastSyncedAt" },
    );
  }

  const projectDir = getProjectDir(slug);
  if (!existsSync(projectDir)) {
    return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`);
  }

  let lastSyncStats: Record<string, unknown> | undefined;
  if (lastSyncStatsRaw) {
    try {
      lastSyncStats = JSON.parse(lastSyncStatsRaw) as Record<string, unknown>;
    } catch {
      return failure("invalid_param", "Failed to parse --lastSyncStats as JSON", {
        param: "lastSyncStats",
      });
    }
  }

  if (flags.dryRun) {
    return success({
      dryRun: true,
      wouldUpdate: { slug, lastSyncedAt, lastSyncGitCommit, lastSyncStats },
    });
  }

  const metaPath = resolve(projectDir, "meta.json");
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    const updated: Record<string, unknown> = {};

    if (lastSyncedAt !== undefined) {
      meta.lastSyncedAt = lastSyncedAt;
      updated.lastSyncedAt = lastSyncedAt;
    }
    if (lastSyncGitCommit !== undefined) {
      meta.lastSyncGitCommit = lastSyncGitCommit;
      updated.lastSyncGitCommit = lastSyncGitCommit;
    }
    if (lastSyncStats !== undefined) {
      meta.lastSyncStats = lastSyncStats;
      updated.lastSyncStats = lastSyncStats;
    }

    await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");

    return success({ slug, updated });
  } catch (err) {
    return failure("update_error", err instanceof Error ? err.message : String(err));
  }
}
