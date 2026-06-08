// ---------------------------------------------------------------------------
// proposal commands — gated codegraph ingestion surface
//
// `proposal list`     read pending proposals from proposals/codegraph.json
// `proposal promote`  enrich-and-promote a proposal into knowledge (create OR merge)
// `proposal drop`     remove a proposal without promoting (records reason in envelope)
// `proposal backfill` migrate legacy graphify-template knowledge entries back to proposals
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readJsonSafe, validateJson } from "../../utils/json.js";
import { knowledgeMetaSchema } from "../../utils/json-schemas.js";
import { deleteKnowledgeEntry, readKnowledgeIndex } from "../../utils/knowledge-store.js";
import { getProjectDir } from "../../utils/paths.js";
import {
  createKnowledgeEntry,
  type KnowledgeKind,
  updateKnowledgeEntry,
} from "../../utils/project-memory.js";
import {
  type Proposal,
  type ProposalKind,
  type ProposalsFile,
  readProposals,
  removeProposal,
  writeProposals,
} from "../../utils/proposal-store.js";
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

// Mirrors the knowledge KIND_ENUM from `knowledge.ts`. Promote accepts the full
// knowledge surface even though codegraph only emits a subset of these kinds —
// the promotion step is the agent's chance to re-classify.
const KIND_ENUM = [
  "lesson",
  "gotcha",
  "pattern",
  "architecture",
  "module",
  "feature",
  "reference",
  "decision",
] as const;

function requireProject(slug: string): CLIResult | string {
  const dir = getProjectDir(slug);
  if (!existsSync(dir)) {
    return failure(ERROR_CODES.PROJECT_NOT_FOUND, `Project "${slug}" not found`, {
      hint: "Run 'arcs project list' to see available projects.",
    });
  }
  return dir;
}

function parseSourceFiles(raw: string): Array<{ path: string; anchor?: string }> {
  return raw.split(",").map((s) => {
    const [path, anchor] = s.trim().split(":");
    return anchor ? { path, anchor } : { path };
  });
}

// ---------------------------------------------------------------------------
// proposal list
// ---------------------------------------------------------------------------

const proposalListParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "proposal list",
  description: "List pending codegraph proposals for a project",
  params: proposalListParams,
  handler: handleProposalList,
});

async function handleProposalList(
  params: ParsedParams<typeof proposalListParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const { slug } = params;
  const projectCheck = requireProject(slug);
  if (typeof projectCheck !== "string") return projectCheck;

  const file = await readProposals(slug);
  if (!file) {
    return success({
      version: 1,
      generatedAt: null,
      graphFingerprint: null,
      proposals: [],
    });
  }
  return success(file);
}

// ---------------------------------------------------------------------------
// proposal promote
// ---------------------------------------------------------------------------

const proposalPromoteParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
  proposalId: {
    type: "string",
    required: true,
    positional: 1,
    description: "Proposal ID to promote",
  },
  title: { type: "string", required: true, description: "Enriched knowledge entry title" },
  kind: {
    type: "string",
    required: true,
    description: "Knowledge entry kind",
    enum: KIND_ENUM,
  },
  summary: { type: "string", required: true, description: "Enriched 1-2 sentence summary" },
  body: { type: "string", description: "Inline markdown body content" },
  "body-file": { type: "string", description: "Path to markdown file with entry body" },
  // --body-stdin is supported here even though plan T012 deferred it on `plan create`
  // and `knowledge create`. Rationale: enriched promote bodies are typically 3-5
  // paragraphs and routinely exceed shell argv limits, so stdin is the right
  // ergonomic default. Logic is byte-identical to knowledge.ts:344 (update-body),
  // which has full coverage. The two write surfaces stay in lockstep — if one
  // changes, the other should too.
  "body-stdin": { type: "boolean", description: "Read body from stdin" },
  "source-files": {
    type: "string",
    description: 'Comma-separated source file refs (e.g. "src/a.ts,src/b.ts:Sym")',
  },
  "merge-with": {
    type: "string",
    description: "Existing knowledge entry ID to append to instead of creating new",
  },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "proposal promote",
  description: "Promote a codegraph proposal into a knowledge entry (create or merge)",
  mutation: true,
  params: proposalPromoteParams,
  handler: handleProposalPromote,
});

async function handleProposalPromote(
  params: ParsedParams<typeof proposalPromoteParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const { slug, proposalId, title, kind, summary } = params;
  const bodyInline = params.body;
  const bodyFile = params["body-file"];
  const bodyStdin = params["body-stdin"];
  const sourceFilesRaw = params["source-files"];
  const mergeWith = params["merge-with"];

  // Project must exist
  const projectCheck = requireProject(slug);
  if (typeof projectCheck !== "string") return projectCheck;
  const projectDir = projectCheck;

  // Body source resolution mirrors `knowledge update-body`
  if (!bodyInline && !bodyFile && !bodyStdin) {
    return failure(
      ERROR_CODES.MISSING_PARAM,
      "Either --body, --body-file, or --body-stdin is required",
      {
        hint: "Provide --body=<content>, --body-file=<path>, or --body-stdin to read from stdin.",
      },
    );
  }
  if (bodyFile && !existsSync(bodyFile)) {
    return failure(ERROR_CODES.ENTITY_NOT_FOUND, `Body file not found: ${bodyFile}`);
  }

  // Verify the proposal exists *before* mutating knowledge — otherwise a
  // typo'd proposalId would leave a dangling knowledge entry behind.
  const proposalsFile = await readProposals(slug);
  const proposal = proposalsFile?.proposals.find((p) => p.id === proposalId);
  if (!proposal) {
    return failure("not_found", `Proposal not found: ${proposalId}`, {
      hint: `Run 'arcs proposal list ${slug}' to see pending proposals.`,
    });
  }

  // For --merge-with, validate the target exists *before* writing anything.
  if (mergeWith) {
    const normalizedTarget = normalizeIdentifier(mergeWith);
    const targetMetaPath = resolve(projectDir, "knowledge", `${normalizedTarget}.meta.json`);
    if (!existsSync(targetMetaPath)) {
      return failure(
        ERROR_CODES.ENTITY_NOT_FOUND,
        `Merge target knowledge entry "${mergeWith}" not found`,
        {
          hint: `Run 'arcs knowledge list ${slug}' to see available entries.`,
        },
      );
    }
  }

  // Resolve the body content
  let body: string;
  if (bodyInline) {
    body = bodyInline;
  } else if (bodyFile) {
    body = await readFile(bodyFile, "utf-8");
  } else {
    body = await readStdin();
  }

  const sourceFiles = sourceFilesRaw ? parseSourceFiles(sourceFilesRaw) : undefined;

  // -------------------------------------------------------------------------
  // Mutation phase. Order: knowledge write → proposal remove. If the proposal
  // remove fails after a successful knowledge write, return the entry id with
  // a warning so the operator knows the durable state is still consistent
  // (knowledge written; proposal stays pending and can be dropped manually).
  // -------------------------------------------------------------------------

  let knowledgeId: string;
  const merged = !!mergeWith;

  try {
    if (mergeWith) {
      const normalizedTarget = normalizeIdentifier(mergeWith);
      const targetMetaPath = resolve(projectDir, "knowledge", `${normalizedTarget}.meta.json`);
      const rawMeta = await readJsonSafe<unknown>(targetMetaPath);
      if (rawMeta === undefined) {
        return failure(ERROR_CODES.ENTITY_NOT_FOUND, `Unable to parse meta for "${mergeWith}"`);
      }
      const existingMeta = validateJson(rawMeta, knowledgeMetaSchema, targetMetaPath);
      const bodyPath = resolve(projectDir, existingMeta.file);
      const existingBody = existsSync(bodyPath) ? await readFile(bodyPath, "utf-8") : "";
      const appended = `${existingBody.replace(/\s+$/, "")}\n\n## From codegraph proposal\n\n${body}\n`;
      await writeFile(bodyPath, appended, "utf-8");
      // Touch updatedAt and refresh sourceFiles if any new ones were supplied
      const mergedSourceFiles =
        sourceFiles && sourceFiles.length > 0
          ? mergeSourceFileLists(existingMeta.sourceFiles ?? [], sourceFiles)
          : undefined;
      await updateKnowledgeEntry(projectDir, {
        id: existingMeta.id,
        ...(mergedSourceFiles && { sourceFiles: mergedSourceFiles }),
      });
      knowledgeId = existingMeta.id;
    } else {
      const id = normalizeIdentifier(title);
      const created = await createKnowledgeEntry(projectDir, {
        id,
        title,
        kind: kind as KnowledgeKind,
        keywords: [],
        summary,
        content: body,
        ...(sourceFiles && { sourceFiles }),
      });
      knowledgeId = created.id;
    }
  } catch (err) {
    return failure("promote_error", err instanceof Error ? err.message : String(err), {
      hint: "Knowledge write failed; proposal was not removed.",
    });
  }

  // Knowledge write succeeded — now remove the proposal.
  let proposalRemoved = false;
  let warning: string | undefined;
  try {
    proposalRemoved = await removeProposal(slug, proposalId);
    if (!proposalRemoved) {
      warning = `Knowledge entry written (${knowledgeId}) but proposal "${proposalId}" was not present at remove time (race?).`;
    }
  } catch (err) {
    warning = `Knowledge entry written (${knowledgeId}) but failed to remove proposal: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }

  return success({
    knowledgeId,
    proposalRemoved,
    merged,
    ...(warning && { warning }),
  });
}

function mergeSourceFileLists(
  existing: Array<{ path: string; anchor?: string }>,
  incoming: Array<{ path: string; anchor?: string }>,
): Array<{ path: string; anchor?: string }> {
  const seen = new Set(existing.map((f) => `${f.path}|${f.anchor ?? ""}`));
  const result = [...existing];
  for (const f of incoming) {
    const key = `${f.path}|${f.anchor ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(f);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// proposal drop
// ---------------------------------------------------------------------------

const proposalDropParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
  proposalId: {
    type: "string",
    required: true,
    positional: 1,
    description: "Proposal ID to drop",
  },
  reason: {
    type: "string",
    required: true,
    description: 'Why the proposal is being dropped (e.g. "noise", "duplicate")',
  },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "proposal drop",
  description: "Remove a codegraph proposal without promoting it",
  mutation: true,
  params: proposalDropParams,
  handler: handleProposalDrop,
});

async function handleProposalDrop(
  params: ParsedParams<typeof proposalDropParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const { slug, proposalId, reason } = params;

  const projectCheck = requireProject(slug);
  if (typeof projectCheck !== "string") return projectCheck;

  const removed = await removeProposal(slug, proposalId);
  if (!removed) {
    return failure("not_found", `Proposal not found: ${proposalId}`, {
      hint: `Run 'arcs proposal list ${slug}' to see pending proposals.`,
    });
  }

  return success({ proposalId, removed: true, reason });
}

// ---------------------------------------------------------------------------
// proposal backfill
//
// One-shot migration: scan the project's knowledge index for entries that
// were emitted by the OLD graphify-template ingester (identified by anchored
// title prefixes) and move them into proposals/codegraph.json so the next
// agent pass can re-enrich them through the proposal gate.
//
// Default mode is dry-run; pass --apply to mutate. Idempotent: re-running
// after a successful migration finds zero matches.
// ---------------------------------------------------------------------------

const TITLE_PREFIX_CLUSTER = "Architecture cluster: ";
const TITLE_PREFIX_GODNODE = "High-connectivity module: ";
const TITLE_PREFIX_COUPLING = "Cross-module coupling: ";
const COUPLING_SEPARATOR = " ↔ ";

interface TemplateMatch {
  knowledgeId: string;
  proposalId: string;
  proposalKind: ProposalKind;
  label: string;
  sourceFiles: Array<{ path: string; anchor?: string }>;
}

/**
 * Local copy of the slugifier from `src/utils/graphify.ts:makeProposalId`.
 * Kept tiny and inlined here to avoid widening graphify.ts's export surface
 * just for the backfill path; the original helper is private to that module.
 *
 * Stable, lowercase, dash-separated. Truncated at 80 chars to keep ids
 * filesystem-friendly.
 */
function makeProposalIdLocal(prefix: string, suffix: string): string {
  const slug = suffix
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug ? `${prefix}-${slug}` : prefix;
}

/**
 * Identify whether a knowledge title was emitted by the old graphify-template
 * ingester. Uses anchored prefixes so user-authored entries that happen to
 * mention the phrase mid-title (e.g. "About the Architecture cluster:
 * pattern…") are NOT matched.
 */
function classifyTitle(
  title: string,
): { kind: ProposalKind; label: string; idPrefix: string } | null {
  if (title.startsWith(TITLE_PREFIX_CLUSTER)) {
    return {
      kind: "architecture",
      label: title.slice(TITLE_PREFIX_CLUSTER.length),
      idPrefix: "graphify-cluster",
    };
  }
  if (title.startsWith(TITLE_PREFIX_GODNODE)) {
    return {
      kind: "module",
      label: title.slice(TITLE_PREFIX_GODNODE.length),
      idPrefix: "graphify-godnode",
    };
  }
  if (title.startsWith(TITLE_PREFIX_COUPLING)) {
    const label = title.slice(TITLE_PREFIX_COUPLING.length);
    // Coupling entries always contain " ↔ "; reject anything else as
    // user-authored prose that happened to start with the prefix.
    if (!label.includes(COUPLING_SEPARATOR)) return null;
    return {
      kind: "gotcha",
      label,
      idPrefix: "graphify-coupling",
    };
  }
  return null;
}

const proposalBackfillParams = {
  slug: { type: "string", required: true, positional: 0, description: "Project slug" },
  apply: {
    type: "boolean",
    description: "Actually mutate state. Without this flag the command runs in dry-run mode.",
  },
} as const satisfies Record<string, ParamDef>;

defineCommand({
  path: "proposal backfill",
  description:
    "Migrate legacy graphify-template knowledge entries back to proposals (dry-run by default; pass --apply to mutate)",
  mutation: true,
  params: proposalBackfillParams,
  handler: handleProposalBackfill,
});

async function handleProposalBackfill(
  params: ParsedParams<typeof proposalBackfillParams>,
  _flags: CommandFlags,
): Promise<CLIResult> {
  const { slug, apply } = params;

  const projectCheck = requireProject(slug);
  if (typeof projectCheck !== "string") return projectCheck;
  const projectDir = projectCheck;

  // -------------------------------------------------------------------------
  // Scan phase — pure, no mutations.
  // -------------------------------------------------------------------------

  const index = await readKnowledgeIndex(projectDir);
  const scanned = index.entries.length;
  const matches: TemplateMatch[] = [];

  for (const entry of index.entries) {
    const classification = classifyTitle(entry.title);
    if (!classification) continue;
    const { kind, label, idPrefix } = classification;
    matches.push({
      knowledgeId: entry.id,
      proposalId: makeProposalIdLocal(idPrefix, label),
      proposalKind: kind,
      label,
      sourceFiles: (entry.sourceFiles ?? []).map((f) => ({
        path: f.path,
        ...(f.anchor && { anchor: f.anchor }),
      })),
    });
  }

  const byKind: Record<string, number> = {};
  for (const m of matches) {
    byKind[m.proposalKind] = (byKind[m.proposalKind] ?? 0) + 1;
  }

  // -------------------------------------------------------------------------
  // Dry-run early return. Also taken when --apply was passed but there is
  // nothing to do — returning `applied: false` plus a hint matches the
  // contract: "applied" reflects whether a mutation actually happened.
  // -------------------------------------------------------------------------

  if (!apply || matches.length === 0) {
    const hint =
      matches.length === 0 ? "Nothing to backfill." : "Run with --apply to commit the migration.";
    return success({
      scanned,
      matched: matches.length,
      byKind,
      applied: false,
      knowledgeRemoved: [],
      proposalsAdded: [],
      skipped: [],
      hint,
    });
  }

  // -------------------------------------------------------------------------
  // Apply phase.
  //
  // Order:
  //   1. Read existing proposals file (may be null).
  //   2. Build the merged proposal set, deduping by id (collisions go to
  //      `skipped` and are NOT removed from knowledge — preserves the
  //      existing proposal's payload and avoids losing data).
  //   3. Write the merged proposals file FIRST (durability — if we crash
  //      after this step the next run still sees them).
  //   4. ONLY THEN delete the migrated knowledge entries.
  // -------------------------------------------------------------------------

  const existingFile = await readProposals(slug);
  const existingProposals = existingFile?.proposals ?? [];
  const existingIds = new Set(existingProposals.map((p) => p.id));

  const skipped: Array<{ id: string; reason: string }> = [];
  const additions: Array<{ proposal: Proposal; knowledgeId: string }> = [];

  for (const m of matches) {
    if (existingIds.has(m.proposalId)) {
      skipped.push({
        id: m.proposalId,
        reason: "proposal with this id already exists; preserving existing payload",
      });
      continue;
    }
    const proposal: Proposal = {
      id: m.proposalId,
      kind: m.proposalKind,
      label: m.label,
      structuralFacts: {},
      sourceFiles: m.sourceFiles,
      suggestedDedupCandidates: [],
    };
    additions.push({ proposal, knowledgeId: m.knowledgeId });
    // Track in-memory so two matched entries that would produce the same id
    // within a single run still collapse via the skipped list.
    existingIds.add(m.proposalId);
  }

  // Nothing actionable left after dedup — short-circuit.
  if (additions.length === 0) {
    return success({
      scanned,
      matched: matches.length,
      byKind,
      applied: true,
      knowledgeRemoved: [],
      proposalsAdded: [],
      skipped,
    });
  }

  // Step 3: write proposals file first (durability before cleanup).
  const mergedProposals: Proposal[] = [...existingProposals, ...additions.map((a) => a.proposal)];
  const mergedFile: ProposalsFile = {
    version: 1,
    generatedAt: existingFile?.generatedAt ?? new Date().toISOString(),
    graphFingerprint: existingFile?.graphFingerprint ?? "backfill",
    proposals: mergedProposals,
  };
  await writeProposals(slug, mergedFile);

  // Step 4: remove the knowledge entries one by one. If any single delete
  // fails we surface that in `skipped`; the proposals file is already durable
  // so the next backfill run will be a no-op for that proposal id (collision)
  // and will retry the knowledge delete (which will then re-skip due to the
  // duplicate proposal id). Operator can clean up manually.
  const knowledgeRemoved: string[] = [];
  for (const a of additions) {
    try {
      await deleteKnowledgeEntry(projectDir, a.knowledgeId);
      knowledgeRemoved.push(a.knowledgeId);
    } catch (err) {
      skipped.push({
        id: a.proposal.id,
        reason: `proposal written but knowledge delete failed for "${a.knowledgeId}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  }

  return success({
    scanned,
    matched: matches.length,
    byKind,
    applied: true,
    knowledgeRemoved,
    proposalsAdded: additions.map((a) => a.proposal.id),
    skipped,
  });
}
