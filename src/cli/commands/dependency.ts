// ---------------------------------------------------------------------------
// Dependency commands — registry-based
// ---------------------------------------------------------------------------

import { readRootMeta, wouldCreateCycle, writeRootMeta } from "../../utils/dag.js";
import { getDataDir } from "../../utils/paths.js";
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
// dependency add
// ---------------------------------------------------------------------------

const dependencyAddParams = {
  slug: { type: "string", required: true, positional: 0, description: "Source project slug" },
  target: {
    type: "string",
    required: true,
    positional: 1,
    description: "Target project slug (dependency)",
  },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "dependency add",
  description: "Add a dependency between two projects",
  mutation: true,
  params: dependencyAddParams,
  handler: handleDependencyAdd,
});

async function handleDependencyAdd(
  params: ParsedParams<typeof dependencyAddParams>,
  flags: CommandFlags,
): Promise<CLIResult> {
  const slug = params.slug;
  const targetSlug = params.target;

  if (flags.dryRun) {
    return success({ dryRun: true, wouldAdd: { slug, target: targetSlug } });
  }

  try {
    const dataDir = getDataDir();
    const rootMeta = await readRootMeta(dataDir);

    const project = rootMeta.projects.find((p) => p.id === slug);
    if (!project) {
      return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`);
    }

    const target = rootMeta.projects.find((p) => p.id === targetSlug);
    if (!target) {
      return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${targetSlug}" not found`);
    }

    if (project.dependsOn.includes(targetSlug)) {
      return success({
        message: `Dependency "${slug}" → "${targetSlug}" already exists.`,
        slug,
        target: targetSlug,
        action: "add",
        noop: true,
      });
    }

    if (wouldCreateCycle(rootMeta.projects, slug, targetSlug)) {
      return failure(
        "cycle_detected",
        `Adding dependency "${slug}" → "${targetSlug}" would create a cycle`,
      );
    }

    project.dependsOn.push(targetSlug);
    await writeRootMeta(dataDir, rootMeta);

    return success({
      slug,
      target: targetSlug,
      action: "add",
      message: `Added dependency: "${slug}" → "${targetSlug}"`,
    });
  } catch (err) {
    return failure("write_error", err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// dependency remove
// ---------------------------------------------------------------------------

const dependencyRemoveParams = {
  slug: { type: "string", required: true, positional: 0, description: "Source project slug" },
  target: {
    type: "string",
    required: true,
    positional: 1,
    description: "Target project slug (dependency)",
  },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "dependency remove",
  description: "Remove a dependency between two projects",
  mutation: true,
  params: dependencyRemoveParams,
  handler: handleDependencyRemove,
});

async function handleDependencyRemove(
  params: ParsedParams<typeof dependencyRemoveParams>,
  flags: CommandFlags,
): Promise<CLIResult> {
  const slug = params.slug;
  const targetSlug = params.target;

  if (flags.dryRun) {
    return success({ dryRun: true, wouldRemove: { slug, target: targetSlug } });
  }

  try {
    const dataDir = getDataDir();
    const rootMeta = await readRootMeta(dataDir);

    const project = rootMeta.projects.find((p) => p.id === slug);
    if (!project) {
      return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`);
    }

    const target = rootMeta.projects.find((p) => p.id === targetSlug);
    if (!target) {
      return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${targetSlug}" not found`);
    }

    const idx = project.dependsOn.indexOf(targetSlug);
    if (idx === -1) {
      return success({
        message: `Dependency "${slug}" → "${targetSlug}" does not exist.`,
        slug,
        target: targetSlug,
        action: "remove",
        noop: true,
      });
    }

    project.dependsOn.splice(idx, 1);
    await writeRootMeta(dataDir, rootMeta);

    return success({
      slug,
      target: targetSlug,
      action: "remove",
      message: `Removed dependency: "${slug}" → "${targetSlug}"`,
    });
  } catch (err) {
    return failure("write_error", err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// doc update — alias for "project update-doc"
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getProjectDir } from "../../utils/paths.js";
import { PROJECT_DOC_FILES, type ProjectDocType } from "../../utils/project-documents.js";

const docUpdateParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
  doc: {
    type: "string",
    required: true,
    positional: 1,
    description: "Document type",
    enum: ["overview", "tasks", "dependencies", "knowledge"],
  },
  "body-file": { type: "string", description: "Path to file with new doc content" },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "doc update",
  description: "Update a project document (alias for project update-doc)",
  mutation: true,
  params: docUpdateParams,
  handler: handleDocUpdate,
});

async function handleDocUpdate(
  params: ParsedParams<typeof docUpdateParams>,
  flags: CommandFlags,
): Promise<CLIResult> {
  const slug = params.slug;
  const doc: ProjectDocType = params.doc;
  const bodyFile = params["body-file"];

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

  if (!bodyFile) {
    return failure(ERROR_CODES.MISSING_PARAM, "--body-file=<path> is required", {
      param: "body-file",
    });
  }

  if (flags.dryRun) {
    return success({ dryRun: true, wouldUpdate: { slug, doc, bodyFile } });
  }

  if (!existsSync(bodyFile)) {
    return failure(ERROR_CODES.ENTITY_NOT_FOUND, `Body file not found: ${bodyFile}`);
  }

  const content = readFileSync(bodyFile, "utf-8");
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
// paths update — alias for "project update-paths" with full legacy API
// ---------------------------------------------------------------------------

import { validateJson } from "../../utils/json.js";
import { projectMetaSchema } from "../../utils/json-schemas.js";
import { normalizeWorkspacePath } from "../../utils/workspace-match.js";

const pathsUpdateParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
  action: {
    type: "string",
    required: true,
    description: "Action to perform",
    enum: ["add", "remove", "set"],
  },
  paths: {
    type: "string",
    required: true,
    description: "Comma-separated list of absolute paths",
  },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "paths update",
  description: "Update workspace paths for a project",
  mutation: true,
  params: pathsUpdateParams,
  handler: handlePathsUpdate,
});

async function handlePathsUpdate(
  params: ParsedParams<typeof pathsUpdateParams>,
  flags: CommandFlags,
): Promise<CLIResult> {
  const slug = params.slug;
  const action = params.action;
  const pathsRaw = params.paths;

  const paths = pathsRaw.split(",").map((p) => p.trim());

  // Validate all paths are absolute
  for (const p of paths) {
    if (!p.startsWith("/")) {
      return failure(ERROR_CODES.INVALID_TYPE, `Path must be absolute, got "${p}"`);
    }
  }

  if (flags.dryRun) {
    return success({ dryRun: true, wouldUpdate: { slug, action, paths } });
  }

  const projectDir = getProjectDir(slug);
  const metaPath = resolve(projectDir, "meta.json");

  if (!existsSync(metaPath)) {
    return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`);
  }

  try {
    const raw = JSON.parse(readFileSync(metaPath, "utf-8"));
    const meta = validateJson(raw, projectMetaSchema, metaPath);
    const current: string[] = Array.isArray(meta.workspacePaths) ? meta.workspacePaths : [];
    const normalized = paths.map(normalizeWorkspacePath);

    let updated: string[];

    switch (action) {
      case "add": {
        const existing = new Set(current);
        updated = [...current, ...normalized.filter((p) => !existing.has(p))];
        break;
      }
      case "remove": {
        const toRemove = new Set(normalized);
        updated = current.filter((p) => !toRemove.has(normalizeWorkspacePath(p)));
        break;
      }
      case "set": {
        updated = [...new Set(normalized)];
        break;
      }
    }

    meta.workspacePaths = updated;
    await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");

    return success({ updated: true, slug, action, paths: updated });
  } catch (err) {
    return failure("write_error", err instanceof Error ? err.message : String(err));
  }
}
