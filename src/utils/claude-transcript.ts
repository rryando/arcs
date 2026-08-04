/**
 * Claude Code transcript mirroring for the session bridge.
 *
 * Owns a per-session sidecar at `sessions/{normalizedId}.transcript.jsonl`
 * that mirrors a Claude Code JSONL transcript (the runtime's single source of
 * truth) into a derived read-model for the web UI. The sidecar is append-only
 * and keyed by transcript line offsets so re-mirroring is idempotent; when the
 * transcript is compacted/rewritten below the mirrored offset, the sidecar is
 * rebuilt from line 0 while preserving ARCS-authored type=reference turns.
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

export interface TranscriptTurn {
  /**
   * Absolute 0-based line index in the source transcript for mirrored turns.
   * Reference turns (type=reference) carry a negative id so they live in a
   * disjoint space and can never collide with transcript line indices.
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
 * Resume offset = the next unmirrored transcript line. Reference turns are
 * excluded (they are ARCS-authored, not transcript lines), and the id of the
 * last mirrored turn is the transcript line index it came from, so
 * `last id + 1` is the count of transcript lines consumed. Equivalent to the
 * sidecar line count in the noise-free case, and correct under interleaved
 * noise and reference turns where a raw line count would drift.
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
 * with existing type=reference turns preserved.
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
        // Compaction/rewrite: rebuild from line 0, preserving references.
        // SHORTCUT: compaction detection is line-count-only — a corrupted or
        // truncated transcript that happens to shrink below the mirrored
        // offset is treated as compaction and mirrored turns are dropped
        // (references always survive). Upgrade when Claude Code's JSONL
        // rewrite signals are identifiable, e.g. a marker record.
        const references = existing.filter((record) => record.type === "reference");
        const { turns: allTurns } = await readTranscriptTurns(transcriptPath, 0);
        await ensureDir(join(projectDir, "sessions"));
        await writeTextAtomic(sidecarPath, serializeRecords([...references, ...allTurns]));
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
 * Appends an ARCS-authored reference turn (document section sent to the
 * session) to the sidecar under the same sessions/.store lock the session
 * store uses, so appends serialize with index mutations. A failed append is a
 * swallowed no-op — the caller has already delivered the message.
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
      const referenceCount = existing.filter((record) => record.type === "reference").length;
      const record: TranscriptTurn = {
        id: -(referenceCount + 1),
        type: "reference",
        text: turn.text ?? "",
        ts: turn.ts ?? nowISO(),
        ...(turn.tool !== undefined ? { tool: turn.tool } : {}),
        ...(turn.section !== undefined ? { section: turn.section } : {}),
        ...(turn.source !== undefined ? { source: turn.source } : {}),
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
