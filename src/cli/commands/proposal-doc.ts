// ---------------------------------------------------------------------------
// proposal-doc commands — human-in-the-loop design proposal documents
// Proposals live as repo-local markdown files under docs/proposals/
// ---------------------------------------------------------------------------

import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { resolveProject } from "../../utils/project-resolver.js";
import { normalizeIdentifier } from "../../utils/slug.js";
import { readStdin } from "../../utils/stdin.js";
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
// Helpers
// ---------------------------------------------------------------------------

const PROPOSALS_DIR = "docs/proposals";

function proposalDocPath(workspaceRoot: string, id: string): string {
  return resolve(workspaceRoot, PROPOSALS_DIR, `${id}.proposal.md`);
}

function proposalDocAcceptedPath(workspaceRoot: string, id: string): string {
  return resolve(workspaceRoot, PROPOSALS_DIR, `${id}.accepted.md`);
}

/** List all `.proposal.md` files and return their base names (without extension). */
function listProposalIds(workspaceRoot: string): string[] {
  const dir = resolve(workspaceRoot, PROPOSALS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".proposal.md"))
    .map((f) => basename(f, ".proposal.md"))
    .sort();
}

const PROPOSAL_TEMPLATE = (title: string): string => `# ${title}

## Motivation / Non-goals


## Current state


## Proposed design


## Impact & risks


## Acceptance criteria


## Decision

*Approved: _when_ — rationale: _rejected alternative summaries_*
`;

// ---------------------------------------------------------------------------
// proposal-doc create
// ---------------------------------------------------------------------------

const proposalDocCreateParams = {
  slug: {
    type: "string",
    required: true,
    positional: 0,
    description: "Project slug to create proposal doc for",
  },
  title: {
    type: "string",
    required: true,
    positional: 1,
    description: "Proposal title (also used for the identifier)",
  },
  body: { type: "string", description: "Inline markdown body (overrides template)" },
  "body-file": { type: "string", description: "Path to markdown file with proposal body" },
  "body-stdin": { type: "boolean", description: "Read body from stdin" },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "proposal-doc create",
  description: "Scaffold a new proposal document in docs/proposals/",
  mutation: true,
  params: proposalDocCreateParams,
  handler: handleProposalDocCreate,
});

async function handleProposalDocCreate(
  params: ParsedParams<typeof proposalDocCreateParams>,
  flags: CommandFlags,
): Promise<CLIResult> {
  const slug = params.slug;
  const title = params.title;
  const bodyInline = params.body;
  const bodyFile = params["body-file"];
  const bodyStdin = params["body-stdin"];

  const resolved = await resolveProject(slug);
  if (!resolved.ok) return resolved.result;
  const workspaceRoot = resolved.workspacePath;
  if (!workspaceRoot) {
    return failure(
      "no_workspace_path",
      `Project "${slug}" has no workspace path configured — cannot write proposal doc`,
    );
  }

  const id = normalizeIdentifier(title);

  if (flags.dryRun) {
    return success({
      dryRun: true,
      wouldCreate: {
        slug,
        title,
        id,
        path: `docs/proposals/${id}.proposal.md`,
        hasBody: !!(bodyInline || bodyFile || bodyStdin),
      },
    });
  }

  const filePath = proposalDocPath(workspaceRoot, id);
  if (existsSync(filePath)) {
    return failure(ERROR_CODES.CREATE_ERROR, `Proposal doc already exists: docs/proposals/${id}.proposal.md`, {
      hint: `Use 'arcs proposal-doc edit ${slug} ${id}' to update it.`,
    });
  }

  // Resolve body content: inline > file > stdin > template
  let body: string;
  if (bodyInline) {
    body = bodyInline;
  } else if (bodyFile) {
    if (!existsSync(bodyFile)) {
      return failure(ERROR_CODES.ENTITY_NOT_FOUND, `Body file not found: ${bodyFile}`);
    }
    body = await readFile(bodyFile, "utf-8");
  } else if (bodyStdin) {
    body = await readStdin();
  } else {
    body = PROPOSAL_TEMPLATE(title);
  }

  // Ensure directory exists
  const dir = resolve(workspaceRoot, PROPOSALS_DIR);
  await mkdir(dir, { recursive: true });

  await writeFile(filePath, body, "utf-8");

  return success({
    slug,
    id,
    path: `docs/proposals/${id}.proposal.md`,
    fullPath: filePath,
  });
}

// ---------------------------------------------------------------------------
// proposal-doc list
// ---------------------------------------------------------------------------

const proposalDocListParams = {
  slug: {
    type: "string",
    required: true,
    positional: 0,
    description: "Project slug",
  },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "proposal-doc list",
  description: "List pending proposal documents",
  params: proposalDocListParams,
  handler: handleProposalDocList,
});

async function handleProposalDocList(
  params: ParsedParams<typeof proposalDocListParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const slug = params.slug;

  const resolved = await resolveProject(slug);
  if (!resolved.ok) return resolved.result;
  const workspaceRoot = resolved.workspacePath;
  if (!workspaceRoot) {
    return success({ slug, proposals: [] });
  }

  const ids = listProposalIds(workspaceRoot);
  const proposals = ids.map((id) => {
    const filePath = proposalDocPath(workspaceRoot, id);
    return { id, path: `docs/proposals/${id}.proposal.md` };
  });

  return success({ slug, proposals });
}

// ---------------------------------------------------------------------------
// proposal-doc get — view a proposal doc body
// ---------------------------------------------------------------------------

const proposalDocGetParams = {
  slug: {
    type: "string",
    required: true,
    positional: 0,
    description: "Project slug",
  },
  id: {
    type: "string",
    required: true,
    positional: 1,
    description: "Proposal doc identifier (without .proposal.md)",
  },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "proposal-doc get",
  description: "View the body of a proposal document",
  params: proposalDocGetParams,
  handler: handleProposalDocGet,
});

async function handleProposalDocGet(
  params: ParsedParams<typeof proposalDocGetParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const slug = params.slug;
  const id = params.id;

  const resolved = await resolveProject(slug);
  if (!resolved.ok) return resolved.result;
  const workspaceRoot = resolved.workspacePath;
  if (!workspaceRoot) {
    return failure("no_workspace_path", `Project "${slug}" has no workspace path configured`);
  }

  // Try .proposal.md first, then .accepted.md
  let filePath = proposalDocPath(workspaceRoot, id);
  let status = "pending";
  if (!existsSync(filePath)) {
    filePath = proposalDocAcceptedPath(workspaceRoot, id);
    status = "accepted";
    if (!existsSync(filePath)) {
      return failure(
        ERROR_CODES.ENTITY_NOT_FOUND,
        `Proposal doc not found: ${id} (tried .proposal.md and .accepted.md)`,
        {
          hint: `Run 'arcs proposal-doc list ${slug}' to see available proposals.`,
        },
      );
    }
  }

  const body = await readFile(filePath, "utf-8");
  return success({
    slug,
    id,
    status,
    path: `docs/proposals/${id}.${status}.md`,
    body,
  });
}

// ---------------------------------------------------------------------------
// proposal-doc edit — replace body of a proposal doc
// ---------------------------------------------------------------------------

const proposalDocEditParams = {
  slug: {
    type: "string",
    required: true,
    positional: 0,
    description: "Project slug",
  },
  id: {
    type: "string",
    required: true,
    positional: 1,
    description: "Proposal doc identifier (without .proposal.md)",
  },
  body: { type: "string", description: "Inline markdown body (replaces content)" },
  "body-file": { type: "string", description: "Path to markdown file with proposal body" },
  "body-stdin": { type: "boolean", description: "Read body from stdin" },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "proposal-doc edit",
  description: "Replace the body of a proposal document",
  mutation: true,
  params: proposalDocEditParams,
  handler: handleProposalDocEdit,
});

async function handleProposalDocEdit(
  params: ParsedParams<typeof proposalDocEditParams>,
  flags: CommandFlags,
): Promise<CLIResult> {
  const slug = params.slug;
  const id = params.id;
  const bodyInline = params.body;
  const bodyFile = params["body-file"];
  const bodyStdin = params["body-stdin"];

  if (!bodyInline && !bodyFile && !bodyStdin) {
    return failure(ERROR_CODES.MISSING_PARAM, "Provide --body, --body-file, or --body-stdin", {
      hint: "Use --body=<content>, --body-file=<path>, or --body-stdin to supply replacement content.",
    });
  }

  const resolved = await resolveProject(slug);
  if (!resolved.ok) return resolved.result;
  const workspaceRoot = resolved.workspacePath;
  if (!workspaceRoot) {
    return failure("no_workspace_path", `Project "${slug}" has no workspace path configured`);
  }

  // Try .proposal.md first, then .accepted.md
  let filePath = proposalDocPath(workspaceRoot, id);
  let status = "pending";
  if (!existsSync(filePath)) {
    filePath = proposalDocAcceptedPath(workspaceRoot, id);
    status = "accepted";
    if (!existsSync(filePath)) {
      return failure(
        ERROR_CODES.ENTITY_NOT_FOUND,
        `Proposal doc not found: ${id}`,
        { hint: `Run 'arcs proposal-doc list ${slug}' to see available proposals.` },
      );
    }
  }

  let body: string;
  if (bodyInline) {
    body = bodyInline;
  } else if (bodyFile) {
    if (!existsSync(bodyFile)) {
      return failure(ERROR_CODES.ENTITY_NOT_FOUND, `Body file not found: ${bodyFile}`);
    }
    body = await readFile(bodyFile, "utf-8");
  } else {
    body = await readStdin();
  }

  if (flags.dryRun) {
    return success({
      dryRun: true,
      slug,
      id,
      wouldUpdate: { path: `docs/proposals/${id}.${status}.md`, bodyLength: body.length },
    });
  }

  await writeFile(filePath, body, "utf-8");
  return success({
    slug,
    id,
    status,
    path: `docs/proposals/${id}.${status}.md`,
    bodyLength: body.length,
  });
}

// ---------------------------------------------------------------------------
// proposal-doc promote — convert approved proposal into an ARCS plan
// ---------------------------------------------------------------------------

const proposalDocPromoteParams = {
  slug: {
    type: "string",
    required: true,
    positional: 0,
    description: "Project slug",
  },
  id: {
    type: "string",
    required: true,
    positional: 1,
    description: "Proposal doc identifier (from filename, without .proposal.md)",
  },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "proposal-doc promote",
  description: "Promote an approved proposal doc into an ARCS plan",
  mutation: true,
  params: proposalDocPromoteParams,
  handler: handleProposalDocPromote,
});

async function handleProposalDocPromote(
  params: ParsedParams<typeof proposalDocPromoteParams>,
  flags: CommandFlags,
): Promise<CLIResult> {
  const slug = params.slug;
  const id = params.id;

  const resolved = await resolveProject(slug);
  if (!resolved.ok) return resolved.result;
  const workspaceRoot = resolved.workspacePath;
  if (!workspaceRoot) {
    return failure("no_workspace_path", `Project "${slug}" has no workspace path configured`);
  }

  const filePath = proposalDocPath(workspaceRoot, id);
  if (!existsSync(filePath)) {
    return failure(
      ERROR_CODES.ENTITY_NOT_FOUND,
      `Proposal doc not found: docs/proposals/${id}.proposal.md`,
      {
        hint: `Run 'arcs proposal-doc list ${slug}' to see available proposals.`,
      },
    );
  }

  // Read the proposal body and infer a title from the first heading
  const body = await readFile(filePath, "utf-8");
  const titleLine = body.split("\n").find((l) => l.startsWith("# "));
  const title = titleLine ? titleLine.replace(/^#\s+/, "").trim() : id;

  if (flags.dryRun) {
    return success({
      dryRun: true,
      slug,
      wouldPromote: {
        id,
        title,
        planAction: `arcs plan create ${slug} "${title}" --body-file="${filePath}"`,
        docAction: "rename .proposal.md -> .accepted.md",
      },
    });
  }

  // Rename .proposal.md → .accepted.md so the content survives for plan creation.
  // The skill orchestrator calls `arcs plan create --body-file=<accepted-path>` next.
  const acceptedPath = proposalDocAcceptedPath(workspaceRoot, id);
  await rename(filePath, acceptedPath);

  return success({
    slug,
    id,
    title,
    docPath: `docs/proposals/${id}.accepted.md`,
    planCommand: `arcs plan create ${slug} "${title}" --body-file="${acceptedPath}"`,
  });
}