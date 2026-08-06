/**
 * Claude Code transcript mirroring for the session bridge.
 *
 * Owns a per-session sidecar at `sessions/{normalizedId}.transcript.jsonl`
 * that mirrors a Claude Code JSONL transcript (the runtime's single source of
 * truth) into a derived read-model for the web UI. The sidecar is append-only
 * and keyed by transcript line offsets so re-mirroring is idempotent; when the
 * transcript is compacted/rewritten below the mirrored offset, the sidecar is
 * rebuilt from line 0 while preserving ARCS-authored turns (any record with a
 * negative id — references and web-sent user/assistant turns).
 *
 * Never throws: missing/unreadable/oversized/malformed inputs are silent
 * no-ops, and the sidecar never touches `sessions/index.json`.
 */

import { appendFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { withLock } from "./file-lock.js";
import { normalizeIdentifier } from "./slug.js";
import { ensureDir, nowISO, writeTextAtomic } from "./storage-utils.js";

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
 * the union, and therefore the shape every reference turn already on disk
 * carries. Its `section`/`source` fields are frozen: a sidecar written by an
 * older ARCS must keep parsing, and a doc reference written today must stay
 * byte-identical to one written then. The tag is filled in at the schema
 * boundary (`sessionReferenceSchema`) rather than required on the wire, because
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

/** Everything a caller can point a session at, discriminated on `type`. */
export type SessionReference = DocReference | FileReference | NodeReference;

/** The pointer kinds, which have no historical fields of their own and so ride
 *  a reference turn whole (see `TranscriptTurn.ref`). */
export type PointerReference = FileReference | NodeReference;

/**
 * The `text` a reference TURN records — the sidecar's own label, which is what
 * the transcript panel shows. NOT prompt text: rendering a reference for a
 * model is `web-server/prompt-assembly.ts`'s exclusive job. Doc references keep
 * the caller's quoted text verbatim (unchanged from before the union); the
 * pointer kinds have no text of their own, so the turn carries their identity.
 */
export function referenceTurnText(reference: SessionReference): string {
  switch (reference.type) {
    case "file":
      return `${reference.path}:${reference.startLine}-${reference.endLine}`;
    case "node":
      return `${reference.kind} ${reference.id}`;
    default:
      return reference.text;
  }
}

export interface TranscriptTurn {
  /**
   * Absolute 0-based line index in the source transcript for mirrored turns.
   * ARCS-authored turns (references and web-sent user/assistant turns) carry a
   * negative id drawn from one shared monotonic sequence, so they live in a
   * disjoint space and can never collide with transcript line indices or with
   * each other (the panel keys TurnRow on id).
   */
  id: number;
  type: "user" | "assistant" | "reference";
  text: string;
  ts?: string;
  tool?: { name: string };
  /** Reference turns only: the MarkdownSection payload the caller sent to the
   *  session, preserved for click-through rendering. */
  section?: ReferenceSection;
  /** Reference turns only: identity of the source document. */
  source?: ReferenceSource;
  /**
   * Reference turns only, POINTER kinds only: the file-slice or DAG-node
   * payload the caller sent, preserved whole. Doc references deliberately do
   * NOT land here — they keep their historical `section`/`source` fields, so a
   * record written today is byte-identical to one written before the union
   * existed and an older sidecar still reads.
   */
  ref?: PointerReference;
  /**
   * Run this turn was folded down from (see web-server/run-event-log.ts). Set
   * only on ARCS-authored turns written at a run's settle, where it doubles as
   * the fold's idempotence marker: a run whose id already appears here has
   * been folded and is never folded again.
   */
  run?: string;
}

export interface ReadTranscriptResult {
  turns: TranscriptTurn[];
  /** Number of record lines in the transcript (trailing newline excluded). */
  totalLines: number;
}

export interface ReferenceTurnInput {
  text?: string;
  ts?: string;
  tool?: { name: string };
  section?: ReferenceSection;
  source?: ReferenceSource;
  /** Pointer kinds only — see `TranscriptTurn.ref`. */
  ref?: PointerReference;
}

/** An ARCS-authored user/assistant turn sent to the session from the web UI. */
export interface SessionTurnInput {
  type: "user" | "assistant";
  text: string;
  ts?: string;
  /** Tool this turn stands for — a `tool_use` folded down from a run's event
   *  log, rendered dimmed exactly like a mirrored tool turn. */
  tool?: { name: string };
  /** Run this turn was folded down from; also the fold's idempotence marker. */
  run?: string;
}

/** Single-read cap for transcript files; anything larger mirrors as a no-op. */
export const TRANSCRIPT_MAX_BYTES = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Paths & locking
// ---------------------------------------------------------------------------

/**
 * Sidecar path. The filename keys on the normalized id so it matches the
 * session index record exactly (normalizeIdentifier round-trips UUIDs
 * unchanged, so Claude Code session uuids survive verbatim).
 */
export function sessionTranscriptPath(projectDir: string, normalizedId: string): string {
  return join(projectDir, "sessions", `${normalizeIdentifier(normalizedId)}.transcript.jsonl`);
}

/**
 * The same advisory lock the session store uses for index mutations. Kept
 * local (not imported) because session-store's helper is private and that
 * module is out of scope; the path mirrors its `sessions/.store` so appends
 * here serialize with createSession/updateSession/etc.
 */
function sessionStoreLockPath(projectDir: string): string {
  return join(projectDir, "sessions", ".store");
}

// ---------------------------------------------------------------------------
// Transcript parser — verified against the real Claude Code JSONL shape
// ---------------------------------------------------------------------------

function isBlock(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Concatenates non-empty text blocks; thinking/tool_use blocks are dropped. */
function extractTextBlocks(blocks: unknown[]): string {
  return blocks
    .filter(
      (block) =>
        isBlock(block) &&
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text !== "",
    )
    .map((block) => (block as { text: string }).text)
    .join("\n");
}

/**
 * Parses one transcript line into a normalized turn, or null when the line is
 * noise/malformed. Malformed JSON is skipped, never thrown.
 *
 * Noise rules (verified against real ~/.claude/projects JSONL transcripts):
 * - types other than "user"/"assistant" (mode, agent-setting, permission-mode,
 *   file-history-snapshot, last-prompt, queue-operation, system, attachment…)
 * - user entries with isMeta:true (the <local-command-caveat> wrapper)
 * - user local-command payloads (<command-name>/<local-command-stdout>), which
 *   in practice carry NO isMeta flag at all — filtered by content marker
 * - user entries whose content is a tool_result array (tool output echoes)
 * - thinking blocks inside assistant content
 * - assistant lines with neither text nor tool_use (thinking-only lines)
 */
function parseTranscriptLine(rawLine: string, lineIndex: number): TranscriptTurn | null {
  if (rawLine.trim() === "") return null;
  let entry: unknown;
  try {
    entry = JSON.parse(rawLine);
  } catch {
    return null;
  }
  if (!isBlock(entry)) return null;
  if (entry.type !== "user" && entry.type !== "assistant") return null;
  const message = entry.message;
  if (!isBlock(message)) return null;
  const ts = typeof entry.timestamp === "string" ? entry.timestamp : undefined;

  if (entry.type === "user") {
    if (entry.isMeta === true) return null;
    const content = message.content;
    if (typeof content === "string") {
      const text = content.trim();
      if (
        text.startsWith("<command-name>") ||
        text.startsWith("<local-command-stdout>") ||
        text.startsWith("<local-command-caveat>")
      ) {
        return null;
      }
      return { id: lineIndex, type: "user", text, ...(ts !== undefined ? { ts } : {}) };
    }
    if (Array.isArray(content)) {
      // Claude Code user arrays are tool_result blocks — echoed tool output,
      // never a real prompt. (The rare text-only array, e.g. an interruption
      // notice, is kept.)
      if (content.some((block) => isBlock(block) && block.type === "tool_result")) return null;
      const text = extractTextBlocks(content);
      if (text === "") return null;
      return { id: lineIndex, type: "user", text, ...(ts !== undefined ? { ts } : {}) };
    }
    return null;
  }

  // assistant — content is a block array: keep text, dim tool_use, drop thinking.
  if (!Array.isArray(message.content)) return null;
  const text = extractTextBlocks(message.content);
  const toolUse = message.content.find(
    (block) => isBlock(block) && block.type === "tool_use" && typeof block.name === "string",
  );
  if (text === "" && toolUse === undefined) return null;
  const turn: TranscriptTurn = {
    id: lineIndex,
    type: "assistant",
    text,
    ...(ts !== undefined ? { ts } : {}),
  };
  if (toolUse !== undefined) turn.tool = { name: (toolUse as { name: string }).name };
  return turn;
}

/**
 * Reads a Claude Code JSONL transcript and parses only lines >= fromLine.
 * Returns the kept turns (absolute line indices) plus the transcript's total
 * record-line count. Never throws — unreadable files yield empty results.
 */
export async function readTranscriptTurns(
  filePath: string,
  fromLine: number,
): Promise<ReadTranscriptResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return { turns: [], totalLines: 0 };
  }
  const lines = raw.split("\n");
  // A trailing newline produces one empty split element — not a record line.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const totalLines = lines.length;
  const turns: TranscriptTurn[] = [];
  for (let lineIndex = fromLine; lineIndex < totalLines; lineIndex++) {
    const turn = parseTranscriptLine(lines[lineIndex] ?? "", lineIndex);
    if (turn !== null) turns.push(turn);
  }
  return { turns, totalLines };
}

// ---------------------------------------------------------------------------
// Sidecar read/write
// ---------------------------------------------------------------------------

function parseSidecarLine(rawLine: string): TranscriptTurn | null {
  if (rawLine.trim() === "") return null;
  try {
    const parsed = JSON.parse(rawLine) as TranscriptTurn;
    if (
      isBlock(parsed) &&
      (parsed.type === "user" || parsed.type === "assistant" || parsed.type === "reference")
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/** Reads the sidecar, skipping malformed lines. Never throws. */
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

/**
 * Resume offset = the next unmirrored transcript line. ARCS-authored turns are
 * excluded (they are not transcript lines, and their negative ids never exceed
 * the -1 sentinel, so they cannot push the offset), and the id of the last
 * mirrored turn is the transcript line index it came from, so
 * `last id + 1` is the count of transcript lines consumed. Equivalent to the
 * sidecar line count in the noise-free case, and correct under interleaved
 * noise and ARCS-authored turns where a raw line count would drift.
 */
function mirrorOffset(records: TranscriptTurn[]): number {
  let lastMirroredId = -1;
  for (const record of records) {
    if (
      record.type !== "reference" &&
      typeof record.id === "number" &&
      record.id > lastMirroredId
    ) {
      lastMirroredId = record.id;
    }
  }
  return lastMirroredId + 1;
}

function serializeRecords(records: TranscriptTurn[]): string {
  if (records.length === 0) return "";
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

/**
 * Next id in the shared ARCS-authored negative space: min(existing id < 0) − 1.
 * All ARCS-authored records — session user/assistant turns and references —
 * draw from this one monotonic sequence, so a user turn and a reference can
 * never collide on the same id (the panel renders <TurnRow key={t.id}>).
 * No negative ids yet: first id is −1 (0 − 1).
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Mirrors the transcript into the per-session sidecar (append-only, offset
 * idempotent). When the transcript has fewer lines than the mirrored offset —
 * Claude Code compacts/rewrites its JSONL — the sidecar is rebuilt from line 0
 * with existing ARCS-authored turns (id < 0) preserved.
 *
 * Never throws: missing/unreadable/oversized/malformed inputs are silent
 * no-ops and the sidecar stays untouched. Never writes sessions/index.json.
 */
export async function mirrorSessionTranscript(
  projectDir: string,
  normalizedId: string,
  transcriptPath: string,
): Promise<void> {
  try {
    // Cap the single read: oversized transcripts are silently skipped.
    const transcriptStat = await stat(transcriptPath);
    if (!transcriptStat.isFile() || transcriptStat.size > TRANSCRIPT_MAX_BYTES) return;

    await withLock(sessionStoreLockPath(projectDir), async () => {
      const sidecarPath = sessionTranscriptPath(projectDir, normalizedId);
      const existing = await readSidecarRecords(sidecarPath);
      const offset = mirrorOffset(existing);

      const { turns, totalLines } = await readTranscriptTurns(transcriptPath, offset);
      if (totalLines < offset) {
        // Compaction/rewrite: rebuild from line 0, preserving every
        // ARCS-authored turn (id < 0) — references and web-sent user/assistant
        // turns both live in the negative space.
        // SHORTCUT: compaction detection is line-count-only — a corrupted or
        // truncated transcript that happens to shrink below the mirrored
        // offset is treated as compaction and mirrored turns are dropped
        // (ARCS-authored turns always survive). Upgrade when Claude Code's
        // JSONL rewrite signals are identifiable, e.g. a marker record.
        const arsAuthored = existing.filter(
          (record) => typeof record.id === "number" && record.id < 0,
        );
        const { turns: allTurns } = await readTranscriptTurns(transcriptPath, 0);
        await ensureDir(join(projectDir, "sessions"));
        await writeTextAtomic(sidecarPath, serializeRecords([...arsAuthored, ...allTurns]));
        return;
      }
      if (turns.length === 0) return;
      await ensureDir(join(projectDir, "sessions"));
      await appendRecords(sidecarPath, turns);
    });
  } catch {
    // Never throws — every mirror failure is a swallowed no-op.
  }
}

/**
 * Appends an ARCS-authored reference turn (a document section, file slice or
 * DAG node the caller pointed the session at) to the sidecar under the same
 * sessions/.store lock the session
 * store uses, so appends serialize with index mutations. A failed append is a
 * swallowed no-op — the caller has already delivered the message. The id is
 * minted from the shared ARCS-authored negative space so it can never collide
 * with a web-sent user/assistant turn.
 */
export async function appendReferenceTurn(
  projectDir: string,
  normalizedId: string,
  turn: ReferenceTurnInput,
): Promise<void> {
  try {
    await ensureDir(join(projectDir, "sessions"));
    await withLock(sessionStoreLockPath(projectDir), async () => {
      const sidecarPath = sessionTranscriptPath(projectDir, normalizedId);
      const existing = await readSidecarRecords(sidecarPath);
      const record: TranscriptTurn = {
        id: nextNegativeTurnId(existing),
        type: "reference",
        text: turn.text ?? "",
        ts: turn.ts ?? nowISO(),
        ...(turn.tool !== undefined ? { tool: turn.tool } : {}),
        ...(turn.section !== undefined ? { section: turn.section } : {}),
        ...(turn.source !== undefined ? { source: turn.source } : {}),
        // LAST for the POINTER records' sake. It buys the doc record nothing: a
        // doc turn has `ref === undefined`, so this spread contributes no key
        // wherever it sits, and the pre-union key order survives by that absence
        // rather than by this position. What the position DOES fix is the pointer
        // records' own layout — `ref` always trails `section`/`source`, so every
        // file/node turn serializes its keys in one stable order.
        ...(turn.ref !== undefined ? { ref: turn.ref } : {}),
      };
      await appendRecords(sidecarPath, [record]);
    });
  } catch {
    // Failed append is a swallowed no-op.
  }
}

/**
 * Appends an ARCS-authored user/assistant turn (sent to the session from the
 * web UI) to the sidecar under the same sessions/.store lock the session store
 * and the other sidecar writers use, so appends serialize with index mutations
 * and reference appends. A failed append is a swallowed no-op. The id is
 * minted from the shared ARCS-authored negative space so it can never collide
 * with a reference turn — both render through <TurnRow key={t.id}>.
 *
 * `tool` and `run` ride through verbatim: they are what a run's event-log
 * fold-down writes (one turn per `tool_use`, every turn tagged with the run
 * whose log produced it — see web-server/run-event-log.ts).
 */
export async function appendSessionTurn(
  projectDir: string,
  normalizedId: string,
  turn: SessionTurnInput,
): Promise<void> {
  try {
    await ensureDir(join(projectDir, "sessions"));
    await withLock(sessionStoreLockPath(projectDir), async () => {
      const sidecarPath = sessionTranscriptPath(projectDir, normalizedId);
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
 * Reads the sidecar for the GET route, skipping malformed lines. Returns an
 * empty array when the sidecar is missing. Never throws.
 */
export async function readSessionTurns(
  projectDir: string,
  normalizedId: string,
): Promise<TranscriptTurn[]> {
  try {
    return await readSidecarRecords(sessionTranscriptPath(projectDir, normalizedId));
  } catch {
    return [];
  }
}
