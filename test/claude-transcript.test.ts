/**
 * Unit tests for the Claude Code transcript mirror sidecar util.
 *
 * Fixtures reproduce the real ~/.claude JSONL shape (user/assistant mix,
 * local-command markers that carry no isMeta flag, tool_result arrays,
 * thinking blocks, noise record types, malformed lines).
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendReferenceTurn,
  appendSessionTurn,
  mirrorSessionTranscript,
  readSessionTurns,
  readTranscriptTurns,
  sessionTranscriptPath,
  TRANSCRIPT_MAX_BYTES,
} from "../src/utils/claude-transcript.js";
import { createSession } from "../src/utils/session-store.js";
import { fileExists } from "../src/utils/storage-utils.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

const TS = "2026-07-10T01:16:06.833Z";

function userLine(content: string | unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content },
    uuid: "uuid-1",
    timestamp: TS,
    ...extra,
  });
}

function assistantLine(blocks: unknown[], ts = "2026-07-10T01:16:17.150Z"): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: blocks },
    uuid: "uuid-2",
    timestamp: ts,
  });
}

function noiseLine(type: string): string {
  return JSON.stringify({ type, sessionId: "b993ef10-6141-4034-bebf-e821316b9f91" });
}

function writeTranscript(transcriptPath: string, lines: string[]): void {
  writeFileSync(transcriptPath, `${lines.join("\n")}\n`, "utf-8");
}

async function seedProjectDir(dir: string): Promise<string> {
  const projectDir = join(dir, "projects", "demo");
  mkdirSync(join(projectDir, "sessions"), { recursive: true });
  return projectDir;
}

/**
 * Realistic transcript fixture exercising every noise rule:
 * types other than user/assistant, isMeta user, local commands (no isMeta),
 * tool_result arrays, string-vs-array content, thinking blocks, malformed line.
 */
const FIXTURE: string[] = [
  noiseLine("agent-setting"), // 0 skip: type
  noiseLine("mode"), // 1 skip: type
  noiseLine("permission-mode"), // 2 skip: type
  noiseLine("file-history-snapshot"), // 3 skip: type
  noiseLine("last-prompt"), // 4 skip: type
  noiseLine("queue-operation"), // 5 skip: type
  userLine("we want to make this project lean"), // 6 keep: user prompt
  userLine("<command-name>/effort</command-name>\n<command-message>effort</command-message>"), // 7 skip: local command, no isMeta
  userLine("<local-command-caveat>Caveat: local commands below</local-command-caveat>", {
    isMeta: true,
  }), // 8 skip: isMeta
  userLine([{ type: "tool_result", tool_use_id: "t1", content: '{"ok":true}' }]), // 9 skip: tool_result array
  assistantLine([{ type: "thinking", thinking: "hmm" }]), // 10 skip: thinking only
  assistantLine([{ type: "text", text: "I'll start by orienting." }]), // 11 keep: assistant text
  assistantLine([{ type: "tool_use", name: "Bash", input: { command: "ls" } }]), // 12 keep: tool marker
  assistantLine([
    { type: "text", text: "Done — two steps remain." },
    { type: "tool_use", name: "Edit", input: { file: "a.ts" } },
  ]), // 13 keep: text + tool
  userLine("<local-command-stdout>Set effort level to ultracode</local-command-stdout>"), // 14 skip: stdout, no isMeta
  userLine([{ type: "text", text: "[Request interrupted by user]" }]), // 15 keep: text array (not tool_result)
  "this line is not json", // 16 skip: malformed
  assistantLine([{ type: "text", text: "" }]), // 17 skip: empty text, no tool
  assistantLine([{ type: "text", text: "Final answer" }]), // 18 keep: assistant text
];

describe("readTranscriptTurns", () => {
  it("parses the realistic fixture with the verified noise rules", async () => {
    await withTempDataDir(async (dir) => {
      const transcriptPath = join(dir, "transcript.jsonl");
      writeTranscript(transcriptPath, FIXTURE);

      const { turns, totalLines } = await readTranscriptTurns(transcriptPath, 0);

      expect(totalLines).toBe(FIXTURE.length);
      expect(turns).toEqual([
        { id: 6, type: "user", text: "we want to make this project lean", ts: TS },
        {
          id: 11,
          type: "assistant",
          text: "I'll start by orienting.",
          ts: "2026-07-10T01:16:17.150Z",
        },
        {
          id: 12,
          type: "assistant",
          text: "",
          tool: { name: "Bash" },
          ts: "2026-07-10T01:16:17.150Z",
        },
        {
          id: 13,
          type: "assistant",
          text: "Done — two steps remain.",
          tool: { name: "Edit" },
          ts: "2026-07-10T01:16:17.150Z",
        },
        { id: 15, type: "user", text: "[Request interrupted by user]", ts: TS },
        { id: 18, type: "assistant", text: "Final answer", ts: "2026-07-10T01:16:17.150Z" },
      ]);
    });
  });

  it("respects fromLine and keeps absolute line indices", async () => {
    await withTempDataDir(async (dir) => {
      const transcriptPath = join(dir, "transcript.jsonl");
      writeTranscript(transcriptPath, FIXTURE);

      const { turns, totalLines } = await readTranscriptTurns(transcriptPath, 12);

      expect(totalLines).toBe(FIXTURE.length);
      expect(turns.map((turn) => turn.id)).toEqual([12, 13, 15, 18]);
    });
  });

  it("returns an empty result for a missing file without throwing", async () => {
    await withTempDataDir(async (dir) => {
      const { turns, totalLines } = await readTranscriptTurns(join(dir, "nope.jsonl"), 0);
      expect(turns).toEqual([]);
      expect(totalLines).toBe(0);
    });
  });
});

describe("mirrorSessionTranscript offset math", () => {
  it("mirrors all kept turns on a fresh run and is byte-idempotent on rerun", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = await seedProjectDir(dir);
      const transcriptPath = join(dir, "transcript.jsonl");
      writeTranscript(transcriptPath, [
        userLine("prompt one"),
        assistantLine([{ type: "text", text: "answer one" }]),
      ]);

      await mirrorSessionTranscript(projectDir, "abc", transcriptPath);
      const sidecarPath = sessionTranscriptPath(projectDir, "abc");
      const first = readFileUtf8(sidecarPath);
      expect(first.split("\n").filter(Boolean)).toHaveLength(2);

      await mirrorSessionTranscript(projectDir, "abc", transcriptPath);
      expect(readFileUtf8(sidecarPath)).toBe(first);
    });
  });

  it("appends only new lines on growth and is restart-safe on the same sidecar", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = await seedProjectDir(dir);
      const transcriptPath = join(dir, "transcript.jsonl");
      writeTranscript(transcriptPath, [
        userLine("one"),
        assistantLine([{ type: "text", text: "answer one" }]),
      ]);
      await mirrorSessionTranscript(projectDir, "abc", transcriptPath);

      // Transcript grows by two lines.
      appendFileSync(transcriptPath, `${userLine("two")}\n`, "utf-8");
      appendFileSync(
        transcriptPath,
        `${assistantLine([{ type: "text", text: "answer two" }])}\n`,
        "utf-8",
      );
      await mirrorSessionTranscript(projectDir, "abc", transcriptPath);

      const afterGrowth = parseSidecar(readFileUtf8(sidecarPathOf(projectDir, "abc")));
      expect(afterGrowth.map((turn) => turn.id)).toEqual([0, 1, 2, 3]);
      expect(afterGrowth.map((turn) => turn.text)).toEqual([
        "one",
        "answer one",
        "two",
        "answer two",
      ]);

      // Restart-safe: a third call on the same sidecar appends nothing.
      const stable = readFileUtf8(sidecarPathOf(projectDir, "abc"));
      await mirrorSessionTranscript(projectDir, "abc", transcriptPath);
      expect(readFileUtf8(sidecarPathOf(projectDir, "abc"))).toBe(stable);
    });
  });

  it("stays idempotent with interleaved noise lines", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = await seedProjectDir(dir);
      const transcriptPath = join(dir, "transcript.jsonl");
      writeTranscript(transcriptPath, [
        noiseLine("mode"),
        userLine("one"),
        assistantLine([{ type: "text", text: "answer one" }]),
        noiseLine("agent-setting"),
      ]);
      await mirrorSessionTranscript(projectDir, "abc", transcriptPath);

      const first = readFileUtf8(sidecarPathOf(projectDir, "abc"));
      const parsed = parseSidecar(first);
      expect(parsed.map((turn) => turn.id)).toEqual([1, 2]);

      // Rerun with a noise line appended after the last turn: nothing new.
      appendFileSync(transcriptPath, `${noiseLine("queue-operation")}\n`, "utf-8");
      await mirrorSessionTranscript(projectDir, "abc", transcriptPath);
      expect(readFileUtf8(sidecarPathOf(projectDir, "abc"))).toBe(first);

      // Growth after noise still appends only new kept turns.
      appendFileSync(transcriptPath, `${userLine("two")}\n`, "utf-8");
      await mirrorSessionTranscript(projectDir, "abc", transcriptPath);
      const grown = parseSidecar(readFileUtf8(sidecarPathOf(projectDir, "abc")));
      expect(grown.map((turn) => turn.id)).toEqual([1, 2, 5]);
    });
  });
});

describe("mirrorSessionTranscript shrink-guard", () => {
  it("preserves reference turns and re-mirrors from line 0 after compaction", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = await seedProjectDir(dir);
      const transcriptPath = join(dir, "transcript.jsonl");
      writeTranscript(transcriptPath, [
        userLine("q1"),
        assistantLine([{ type: "text", text: "a1" }]),
        userLine("q2"),
        assistantLine([{ type: "text", text: "a2" }]),
      ]);
      await mirrorSessionTranscript(projectDir, "abc", transcriptPath);
      await appendReferenceTurn(projectDir, "abc", {
        text: "## Section\nsent doc text",
        section: {
          depth: 1,
          text: "## Section\nsent doc text",
          id: "sec_1",
          startOffset: 4,
          endOffset: 40,
        },
        source: { kind: "knowledge", label: "session-bridge", doc: "docs/bridge.md", id: "k_1" },
      });

      const seeded = parseSidecar(readFileUtf8(sidecarPathOf(projectDir, "abc")));
      expect(seeded).toHaveLength(5);
      expect(seeded.filter((turn) => turn.type === "reference")).toHaveLength(1);

      // Compaction: transcript rewritten to a single user turn.
      writeTranscript(transcriptPath, [userLine("q1")]);
      await mirrorSessionTranscript(projectDir, "abc", transcriptPath);

      const after = parseSidecar(readFileUtf8(sidecarPathOf(projectDir, "abc")));
      expect(after).toHaveLength(2); // reference + re-mirrored turn, no duplicates
      // References are preserved verbatim, section/source included, and come first.
      expect(after[0]).toMatchObject({
        type: "reference",
        text: "## Section\nsent doc text",
        section: {
          depth: 1,
          text: "## Section\nsent doc text",
          id: "sec_1",
          startOffset: 4,
          endOffset: 40,
        },
        source: { kind: "knowledge", label: "session-bridge", doc: "docs/bridge.md", id: "k_1" },
      });
      // Transcript turns are re-mirrored from line 0 with fresh ids.
      expect(after[1]).toEqual({ id: 0, type: "user", text: "q1", ts: TS });
    });
  });

  it("preserves ALL ARCS-authored turns (user AND reference) across compaction", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = await seedProjectDir(dir);
      const transcriptPath = join(dir, "transcript.jsonl");
      writeTranscript(transcriptPath, [
        userLine("q1"),
        assistantLine([{ type: "text", text: "a1" }]),
      ]);
      await mirrorSessionTranscript(projectDir, "abc", transcriptPath);
      // ARCS-authored turns: reference + web-sent user/assistant, ids -1..-3.
      await appendReferenceTurn(projectDir, "abc", { text: "## Section\nsent doc text" });
      await appendSessionTurn(projectDir, "abc", { type: "user", text: "from web" });
      await appendSessionTurn(projectDir, "abc", { type: "assistant", text: "web ack" });

      const seeded = parseSidecar(readFileUtf8(sidecarPathOf(projectDir, "abc")));
      expect(seeded.map((turn) => turn.id)).toEqual([0, 1, -1, -2, -3]);

      // Compaction: transcript rewritten to a single user turn.
      writeTranscript(transcriptPath, [userLine("q1")]);
      await mirrorSessionTranscript(projectDir, "abc", transcriptPath);

      const after = parseSidecar(readFileUtf8(sidecarPathOf(projectDir, "abc")));
      // All three ARCS-authored turns survive (negative ids, ARCS-authored
      // first) plus the re-mirrored turn — no duplicates, none dropped.
      expect(after.map((turn) => turn.id)).toEqual([-1, -2, -3, 0]);
      expect(after.map((turn) => turn.type)).toEqual(["reference", "user", "assistant", "user"]);
      expect(after[1]).toMatchObject({ type: "user", text: "from web" });
      expect(after[2]).toMatchObject({ type: "assistant", text: "web ack" });
      expect(after[3]).toEqual({ id: 0, type: "user", text: "q1", ts: TS });
    });
  });
});

describe("mirrorSessionTranscript failure no-ops", () => {
  it("no-ops on a missing transcript", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = await seedProjectDir(dir);
      await expect(
        mirrorSessionTranscript(projectDir, "abc", join(dir, "missing.jsonl")),
      ).resolves.toBeUndefined();
      expect(await fileExists(sidecarPathOf(projectDir, "abc"))).toBe(false);
    });
  });

  it("no-ops on an unreadable transcript path (a directory)", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = await seedProjectDir(dir);
      const transcriptPath = join(dir, "not-a-file.jsonl");
      mkdirSync(transcriptPath);

      await expect(
        mirrorSessionTranscript(projectDir, "abc", transcriptPath),
      ).resolves.toBeUndefined();
      expect(await fileExists(sidecarPathOf(projectDir, "abc"))).toBe(false);
    });
  });

  it("no-ops on an oversized transcript (>20MB)", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = await seedProjectDir(dir);
      const transcriptPath = join(dir, "big.jsonl");
      writeFileSync(transcriptPath, Buffer.alloc(TRANSCRIPT_MAX_BYTES + 1, 0x61));

      await expect(
        mirrorSessionTranscript(projectDir, "abc", transcriptPath),
      ).resolves.toBeUndefined();
      expect(await fileExists(sidecarPathOf(projectDir, "abc"))).toBe(false);
    });
  });

  it("no-ops on a fully malformed transcript and keeps the sidecar unchanged", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = await seedProjectDir(dir);
      const transcriptPath = join(dir, "transcript.jsonl");
      writeTranscript(transcriptPath, [
        userLine("one"),
        assistantLine([{ type: "text", text: "answer one" }]),
      ]);
      await mirrorSessionTranscript(projectDir, "abc", transcriptPath);
      const before = readFileUtf8(sidecarPathOf(projectDir, "abc"));

      // Replace with garbage that is still larger than the mirrored offset, so
      // the no-op path is the malformed-skip, not the shrink-rewrite.
      writeFileSync(transcriptPath, "not json\nstill not json\nneither\n", "utf-8");
      await expect(
        mirrorSessionTranscript(projectDir, "abc", transcriptPath),
      ).resolves.toBeUndefined();
      expect(readFileUtf8(sidecarPathOf(projectDir, "abc"))).toBe(before);
    });
  });

  it("skips malformed lines interleaved with growth without throwing", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = await seedProjectDir(dir);
      const transcriptPath = join(dir, "transcript.jsonl");
      writeTranscript(transcriptPath, [userLine("one")]);
      await mirrorSessionTranscript(projectDir, "abc", transcriptPath);

      appendFileSync(transcriptPath, "broken line\n", "utf-8");
      appendFileSync(
        transcriptPath,
        `${assistantLine([{ type: "text", text: "answer one" }])}\n`,
        "utf-8",
      );
      await expect(
        mirrorSessionTranscript(projectDir, "abc", transcriptPath),
      ).resolves.toBeUndefined();

      const turns = parseSidecar(readFileUtf8(sidecarPathOf(projectDir, "abc")));
      expect(turns.map((turn) => turn.id)).toEqual([0, 2]);
    });
  });
});

describe("sidecar never touches index.json", () => {
  it("leaves sessions/index.json byte-identical after mirroring", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = await seedProjectDir(dir);
      const indexPath = join(projectDir, "sessions", "index.json");
      const indexBytes =
        '{"sessions":[{"id":"abc","normalizedId":"abc","runtimeType":"claude-code","runtimeSessionId":"abc","status":"active","startedAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}]}\n';
      writeFileSync(indexPath, indexBytes, "utf-8");

      const transcriptPath = join(dir, "transcript.jsonl");
      writeTranscript(transcriptPath, [
        userLine("one"),
        assistantLine([{ type: "text", text: "answer one" }]),
      ]);
      await mirrorSessionTranscript(projectDir, "abc", transcriptPath);
      await appendReferenceTurn(projectDir, "abc", { text: "ref" });
      await appendSessionTurn(projectDir, "abc", { type: "user", text: "from web" });
      await appendSessionTurn(projectDir, "abc", { type: "assistant", text: "web ack" });

      expect(readFileUtf8(indexPath)).toBe(indexBytes);
    });
  });

  it("mirrors to the normalized sidecar filename matching the index record", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = await seedProjectDir(dir);
      const session = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "b993ef10-6141-4034-bebf-e821316b9f91",
      });

      const transcriptPath = join(dir, "transcript.jsonl");
      writeTranscript(transcriptPath, [userLine("hello")]);
      await mirrorSessionTranscript(projectDir, session.normalizedId, transcriptPath);

      expect(
        await fileExists(
          join(projectDir, "sessions", "b993ef10-6141-4034-bebf-e821316b9f91.transcript.jsonl"),
        ),
      ).toBe(true);
    });
  });
});

describe("appendReferenceTurn and readSessionTurns", () => {
  it("appends a reference turn readable by readSessionTurns", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = await seedProjectDir(dir);
      await appendReferenceTurn(projectDir, "abc", { text: "## Section\nsent doc text" });

      const turns = await readSessionTurns(projectDir, "abc");
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({
        type: "reference",
        text: "## Section\nsent doc text",
      });
      expect(typeof turns[0]?.id).toBe("number");
      expect(typeof turns[0]?.ts).toBe("string");
    });
  });

  it("carries section and source through the sidecar round-trip", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = await seedProjectDir(dir);
      const section = {
        depth: 1,
        text: "The session drains the queue at the next hook checkpoint.",
        id: "sec_1",
        startOffset: 120,
        endOffset: 220,
      };
      const source = {
        kind: "knowledge",
        label: "session-bridge",
        doc: "docs/bridge.md",
        id: "k_1",
      } as const;
      await appendReferenceTurn(projectDir, "abc", {
        text: "Queue drain happens at the next hook checkpoint.",
        section,
        source,
      });

      const turns = await readSessionTurns(projectDir, "abc");
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({
        type: "reference",
        text: "Queue drain happens at the next hook checkpoint.",
        section,
        source,
      });
      // Negative reference space is preserved alongside the new fields.
      expect(turns[0]?.id).toBe(-1);
      expect(typeof turns[0]?.ts).toBe("string");
    });
  });

  it("returns an empty array for a missing sidecar", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = await seedProjectDir(dir);
      expect(await readSessionTurns(projectDir, "ghost")).toEqual([]);
    });
  });

  it("skips malformed sidecar lines", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = await seedProjectDir(dir);
      await appendReferenceTurn(projectDir, "abc", { text: "ref one" });
      const sidecarPath = sidecarPathOf(projectDir, "abc");
      appendFileSync(sidecarPath, "not valid json\n", "utf-8");
      await mirrorSessionTranscript(projectDir, "abc", join(dir, "missing.jsonl")); // no-op

      const turns = await readSessionTurns(projectDir, "abc");
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({ type: "reference", text: "ref one" });
    });
  });
});

describe("appendSessionTurn shared negative id space", () => {
  it("mints monotonic negative ids across a user/assistant/reference interleave", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = await seedProjectDir(dir);
      await appendSessionTurn(projectDir, "abc", { type: "user", text: "u1" });
      await appendSessionTurn(projectDir, "abc", { type: "assistant", text: "a1" });
      await appendReferenceTurn(projectDir, "abc", { text: "r1" });

      const turns = await readSessionTurns(projectDir, "abc");
      expect(turns.map((turn) => turn.id)).toEqual([-1, -2, -3]); // no -1 collision
      expect(turns.map((turn) => turn.type)).toEqual(["user", "assistant", "reference"]);
      // Unique ids — the panel renders <TurnRow key={t.id}>.
      expect(new Set(turns.map((turn) => turn.id)).size).toBe(3);
    });
  });

  it("a user turn minted after an existing reference continues the shared sequence", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = await seedProjectDir(dir);
      await appendReferenceTurn(projectDir, "abc", { text: "r1" });
      expect((await readSessionTurns(projectDir, "abc"))[0]?.id).toBe(-1);

      await appendSessionTurn(projectDir, "abc", { type: "user", text: "u1" });
      await appendSessionTurn(projectDir, "abc", { type: "assistant", text: "a1" });

      const turns = await readSessionTurns(projectDir, "abc");
      expect(turns.map((turn) => turn.id)).toEqual([-1, -2, -3]);
      expect(turns.map((turn) => turn.type)).toEqual(["reference", "user", "assistant"]);
    });
  });

  it("serializes concurrent appends under the sessions/.store lock", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = await seedProjectDir(dir);
      // Interleave writers in flight: each append re-reads the sidecar under
      // the same lock, so ids stay unique and contiguous.
      await Promise.all([
        appendSessionTurn(projectDir, "abc", { type: "user", text: "u1" }),
        appendReferenceTurn(projectDir, "abc", { text: "r1" }),
        appendSessionTurn(projectDir, "abc", { type: "assistant", text: "a1" }),
        appendReferenceTurn(projectDir, "abc", { text: "r2" }),
        appendSessionTurn(projectDir, "abc", { type: "user", text: "u2" }),
        appendReferenceTurn(projectDir, "abc", { text: "r3" }),
      ]);

      const turns = await readSessionTurns(projectDir, "abc");
      expect(turns).toHaveLength(6);
      const ids = turns.map((turn) => turn.id).sort((a, b) => a - b);
      expect(ids).toEqual([-6, -5, -4, -3, -2, -1]);
    });
  });

  it("is a swallowed no-op when the sessions dir cannot be created", async () => {
    await withTempDataDir(async (dir) => {
      // A regular file where the projectDir's parent should be blocks mkdir.
      writeFileSync(join(dir, "projects"), "i am a file", "utf-8");
      const blockedDir = join(dir, "projects", "demo");

      await expect(
        appendSessionTurn(blockedDir, "abc", { type: "user", text: "u1" }),
      ).resolves.toBeUndefined();
      expect(await fileExists(join(blockedDir, "sessions"))).toBe(false);
    });
  });

  it("is a swallowed no-op when the sidecar is unreadable/unwritable (a directory)", async () => {
    await withTempDataDir(async (dir) => {
      const projectDir = await seedProjectDir(dir);
      // A directory occupying the sidecar path makes read+append fail.
      mkdirSync(sidecarPathOf(projectDir, "abc"), { recursive: true });

      await expect(
        appendSessionTurn(projectDir, "abc", { type: "user", text: "u1" }),
      ).resolves.toBeUndefined();
      await expect(appendReferenceTurn(projectDir, "abc", { text: "r1" })).resolves.toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sidecarPathOf(projectDir: string, normalizedId: string): string {
  return sessionTranscriptPath(projectDir, normalizedId);
}

function readFileUtf8(filePath: string): string {
  return readFileSync(filePath, "utf-8");
}

function parseSidecar(raw: string): Array<Record<string, unknown>> {
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}
