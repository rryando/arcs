/**
 * Per-run transcript sidecar — the durable fold-down target for run event logs.
 *
 * Re-homed from the deleted claude-transcript module: with the sessions entity
 * gone there is no claude JSONL mirror and no hook bridge, so this module keeps
 * exactly the pieces the run fold still needs — the ARCS-authored turn records
 * and the negative-id space they draw from. `foldRunEventLog` (run-event-log.ts)
 * appends one turn per assistant/tool event through `appendSessionTurn`, tagged
 * with the run id, and reads them back through `readSessionTurns` as its
 * no-second-fold marker.
 *
 * The sidecar lives at `sessions/{segment}.transcript.jsonl` where `segment` is
 * whatever directory segment the caller keys the run log with (the project slug
 * for the ask route). Nothing reads it for rendering anymore — the client keeps
 * its own local transcript — but the fold's idempotence marker lives here, so
 * the file is durable state, never scratch.
 *
 * Never throws: missing/unreadable/malformed inputs are silent no-ops, and the
 * sidecar never touches `projects/…/runs/index.json`.
 */

import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { withLock } from "./file-lock.js";
import { normalizeIdentifier } from "./slug.js";
import { ensureDir } from "./storage-utils.js";

/** A MarkdownSection payload the caller sent to the session. Preserved on the
 *  sidecar reference record verbatim so the web UI can render the section with
 *  click-through back to its source document. */
export interface ReferenceSection {
  /** Heading depth of the referenced section (1-based). */
  depth: number;
  /** The section's rendered markdown, exactly as it was sent to the session. */
  text: string;
  /** Stable id of the section within its document. */
  id: string;
  /** Character offsets of the section within the full document text. */
  startOffset: number;
  endOffset: number;
}

/** Identity of the document a reference was quoted from. */
export interface ReferenceSource {
  /** Which ARCS store the referenced document lives in. */
  kind: "overview" | "knowledge" | "plan";
  /** Human-readable name of the source document. */
  label: string;
  /** Optional doc identifier (e.g. knowledge entry id, plan id). */
  doc?: string;
  id?: string;
}

/**
 * A markdown document section — the ONLY reference shape that existed before
 * the union, and therefore the shape every stored reference carries. Its
 * `section`/`source` fields are frozen: the tag is filled in at the schema
 * boundary (`ask.ts`'s preprocess) rather than required on the wire, because
 * legacy bodies carry no tag at all.
 */
export interface DocReference {
  type: "doc";
  text: string;
  section: ReferenceSection;
  source: ReferenceSource;
}

/**
 * A line range in a workspace file, sent as a POINTER rather than as content:
 * `excerpt` is a short human anchor, never the authoritative text — the agent
 * reads the live file. `headRev` is the revision the slice was taken at, so a
 * later diff can tell whether the file moved under the agent.
 */
export interface FileReference {
  type: "file";
  /** Workspace-relative path, as the caller sent it. */
  path: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  excerpt?: string;
  headRev?: string;
}

/** A DAG entity. Carries no text slice — ARCS is the source of truth for it. */
export interface NodeReference {
  type: "node";
  kind: "task" | "plan" | "knowledge";
  id: string;
}

/** Everything a caller can point a turn at, discriminated on `type`. */
export type SessionReference = DocReference | FileReference | NodeReference;

export interface TranscriptTurn {
  /**
   * Id of this ARCS-authored turn. Drawn from one shared monotonic NEGATIVE
   * sequence so user/assistant folds can never collide with each other (the
   * client renders turns keyed on id).
   */
  id: number;
  type: "user" | "assistant";
  text: string;
  ts?: string;
  tool?: { name: string };
  /**
   * Run this turn was folded down from (see web-server/run-event-log.ts). Set
   * only on ARCS-authored turns written at a run's settle, where it doubles as
   * the fold's idempotence marker: a run whose id already appears here has
   * been folded and is never folded again.
   */
  run?: string;
}

/** An ARCS-authored user/assistant turn appended by a run's settle. */
export interface SessionTurnInput {
  type: "user" | "assistant";
  text: string;
  ts?: string;
  /** Tool this turn stands for — a `tool_use` folded down from a run's event
   *  log. */
  tool?: { name: string };
  /** Run this turn was folded down from; also the fold's idempotence marker. */
  run?: string;
}

// ---------------------------------------------------------------------------
// Paths & locking
// ---------------------------------------------------------------------------

/**
 * Sidecar path. The filename keys on the segment the caller folds with (the
 * project slug for the ask route), so it sorts next to that segment's run
 * event logs.
 */
export function runTranscriptPath(projectDir: string, segment: string): string {
  return join(projectDir, "sessions", `${normalizeIdentifier(segment)}.transcript.jsonl`);
}

/**
 * The same advisory lock the run store uses for its index mutations. Kept
 * local (not imported) because run-store's helper is private; the path mirrors
 * its `sessions/.store` so appends here serialize with the fold's readers.
 */
function sessionStoreLockPath(projectDir: string): string {
  return join(projectDir, "sessions", ".store");
}

// ---------------------------------------------------------------------------
// Sidecar read/write
// ---------------------------------------------------------------------------

function isBlock(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSidecarLine(rawLine: string): TranscriptTurn | null {
  if (rawLine.trim() === "") return null;
  try {
    const parsed = JSON.parse(rawLine) as TranscriptTurn;
    if (
      isBlock(parsed) &&
      (parsed.type === "user" || parsed.type === "assistant") &&
      typeof parsed.text === "string"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function readSidecarRecords(filePath: string): Promise<TranscriptTurn[]> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return raw.split("\n").flatMap((line) => {
      const record = parseSidecarLine(line);
      return record !== null ? [record] : [];
    });
  } catch {
    return [];
  }
}

function serializeRecords(records: TranscriptTurn[]): string {
  if (records.length === 0) return "";
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

/**
 * Next id in the shared ARCS-authored negative space: min(existing id < 0) − 1.
 * All ARCS-authored records draw from this one monotonic sequence, so a user
 * fold and an assistant fold can never collide on the same id.
 */
function nextNegativeTurnId(records: TranscriptTurn[]): number {
  let minNegative = 0;
  for (const record of records) {
    if (typeof record.id === "number" && record.id < 0 && record.id < minNegative) {
      minNegative = record.id;
    }
  }
  return minNegative - 1;
}

async function appendRecords(filePath: string, records: TranscriptTurn[]): Promise<void> {
  if (records.length === 0) return;
  await appendFile(filePath, serializeRecords(records), "utf-8");
}

/**
 * Appends an ARCS-authored user/assistant turn under the sessions lock, so
 * appends serialize with the fold's own readers. A failed append is a
 * swallowed no-op. The id is minted from the shared ARCS-authored negative
 * space.
 *
 * `tool` and `run` ride through verbatim: they are what a run's event-log
 * fold-down writes (one turn per `tool_use`, every turn tagged with the run
 * whose log produced it — see web-server/run-event-log.ts).
 */
export async function appendSessionTurn(
  projectDir: string,
  segment: string,
  turn: SessionTurnInput,
): Promise<void> {
  try {
    await ensureDir(join(projectDir, "sessions"));
    await withLock(sessionStoreLockPath(projectDir), async () => {
      const sidecarPath = runTranscriptPath(projectDir, segment);
      const existing = await readSidecarRecords(sidecarPath);
      const record: TranscriptTurn = {
        id: nextNegativeTurnId(existing),
        type: turn.type,
        text: turn.text,
        ...(turn.ts !== undefined ? { ts: turn.ts } : {}),
        ...(turn.tool !== undefined ? { tool: turn.tool } : {}),
        ...(turn.run !== undefined ? { run: turn.run } : {}),
      };
      await appendRecords(sidecarPath, [record]);
    });
  } catch {
    // Failed append is a swallowed no-op.
  }
}

/**
 * Reads the sidecar, skipping malformed lines. Returns an empty array when the
 * sidecar is missing. Never throws.
 */
export async function readSessionTurns(
  projectDir: string,
  segment: string,
): Promise<TranscriptTurn[]> {
  try {
    return await readSidecarRecords(runTranscriptPath(projectDir, segment));
  } catch {
    return [];
  }
}
