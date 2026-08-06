/**
 * Env-gated end-to-end test for the headless turn path (the session panel's
 * headless delivery channel, plan session-bridge-hardening).
 *
 * Exercises the REAL web server and a REAL `claude` binary end to end — no
 * mocks, no stubs, no fake runner:
 *
 *   seed a real claude session (headless) → POST /sessions/:id/turns
 *   → 202 accepted → the observed session is ADOPTED (forked) into a new ARCS
 *   thread → child spawns → exit mapping → the write-back folds the run's event
 *   log → GET /transcript on the WRITE TARGET shows the user turn followed by
 *   the assistant reply, and the observed session is untouched.
 *
 * The test is gated by ARCS_CLAUDE_E2E=1: without it, the single `it` is
 * skipped so the bare file passes in CI (exit 0) even where no `claude` can
 * run. With the gate on, it shells out to a real, authenticated `claude` on
 * PATH (and costs real tokens) — run deliberately, never in CI.
 *
 * This is the only place the ADOPTION FORK is exercised against a real claude:
 * `--resume <observed uuid> --session-id <fresh uuid> --fork-session`. The
 * fork's transcript is a separate file, so asserting the original session's
 * JSONL did not grow is what proves the human's live terminal thread was not
 * hijacked — the failure mode has no error to notice it by (claude accepts
 * `--session-id` equal to `--resume`, exit 0, empty stderr).
 *
 * Known version-drift note: the route builds the child argv WITHOUT `--cwd` —
 * claude >= 2.x rejects it ("unknown option"), settling every headless run as
 * outcome "error". The working directory is owned by the spawn's options.cwd:
 * the route passes `cwd: <dir>` to the runner, which applies it via spawn
 * options (src/web-server/claude-runner.ts). This gated test exercises the
 * route's exact argv so arg drift is caught, not masked.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type Dirent, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createSession } from "../src/utils/session-store.js";
import { startWebServer, type WebServerHandle } from "../src/web-server/index.js";
import { currentWebToken } from "../src/web-server/web-token.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

const e2e = process.env.ARCS_CLAUDE_E2E === "1";

/** Prompt engineered for a deterministic short reply (text not asserted). */
const RUN_MESSAGE = "Reply with exactly the single word ok.";

/** Fail-fast timeout for the child run (runner reads this at spawn time). */
const RUN_TIMEOUT_MS = 60_000;

/** Upper bound for the whole settle+mirror wait; the child itself is killed at
 *  RUN_TIMEOUT_MS, so this just covers slow spawn/mirror plumbing. */
const POLL_DEADLINE_MS = 120_000;

const SAVED_RUN_TIMEOUT = process.env.ARCS_CLAUDE_RUN_TIMEOUT_MS;

afterEach(() => {
  if (SAVED_RUN_TIMEOUT === undefined) {
    delete process.env.ARCS_CLAUDE_RUN_TIMEOUT_MS;
  } else {
    process.env.ARCS_CLAUDE_RUN_TIMEOUT_MS = SAVED_RUN_TIMEOUT;
  }
});

interface Turn {
  id: number;
  type: string;
  text: string;
  ts?: string;
}

interface RunMeta {
  pid?: number | null;
  startedAt?: number;
  endedAt?: number;
  outcome?: string;
  replyChars?: number;
  mode?: string;
}

interface SessionEnvelope {
  ok: boolean;
  data?: {
    normalizedId?: string;
    metadata?: Record<string, unknown>;
  };
}

/**
 * Claude Code persists one JSONL per session under ~/.claude/projects/<escaped
 * workdir>/<session-id>.jsonl. Locates the seed session's file by its unique
 * id filename — no need to re-derive the directory-escaping scheme.
 */
function findSessionTranscript(sessionId: string): string | undefined {
  const root = join(homedir(), ".claude", "projects");
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 5 || found.length > 0) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // no projects dir yet — seed must have failed or claude absent
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name === `${sessionId}.jsonl`) found.push(full);
    }
  };
  walk(root, 0);
  return found[0];
}

/** Seeds a real headless claude session so the resume target exists. */
function seedClaudeSession(workspace: string, sessionId: string): void {
  const result = spawnSync(
    "claude",
    ["-p", "hi", "--session-id", sessionId, "--output-format", "json"],
    { cwd: workspace, encoding: "utf-8", timeout: RUN_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
  );
  if (result.error) {
    throw new Error(`cannot seed a real claude session: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`claude seed exited ${result.status}: ${(result.stderr ?? "").slice(0, 500)}`);
  }
}

/** Polls GET /sessions/:id until metadata.run settles with an endedAt. */
async function waitForRunSettled(
  base: string,
  id: string,
  deadlineMs: number,
): Promise<{ run: RunMeta }> {
  const deadline = Date.now() + deadlineMs;
  let last: RunMeta | undefined;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/api/p/demo/sessions/${id}`);
    const envelope = (await res.json()) as SessionEnvelope;
    expect(res.status).toBe(200);
    const run = envelope.data?.metadata?.run as RunMeta | undefined;
    last = run;
    if (run?.endedAt !== undefined) return { run };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(
    `run did not settle within ${deadlineMs}ms; last metadata.run: ${JSON.stringify(last)}`,
  );
}

/** Complete lines in a claude JSONL transcript — the measure the fork probe
 *  used, so "the original did not grow" is asserted the same way it was found. */
function transcriptLineCount(path: string): number {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "").length;
}

it.skipIf(!e2e)(
  "a headless turn forks the observed session and writes back to the fork",
  async () => {
    await withTempDataDir(async (dir) => {
      writeFileSync(
        resolve(dir, "meta.json"),
        JSON.stringify({
          version: "1.0",
          projects: [{ id: "demo", name: "Demo", status: "active", dependsOn: [] }],
        }),
        "utf-8",
      );
      const projectDir = resolve(dir, "projects", "demo");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        resolve(projectDir, "meta.json"),
        JSON.stringify({
          id: "demo",
          name: "Demo",
          description: "e2e project",
          createdAt: "2026-01-01T00:00:00.000Z",
          workspacePaths: [dir],
        }),
        "utf-8",
      );

      // A real Claude session for the turn to ADOPT: the headless seed writes
      // ~/.claude/projects/<escaped workdir>/<uuid>.jsonl, which the fork
      // inherits the context of and must leave untouched.
      const runtimeSessionId = randomUUID();
      seedClaudeSession(dir, runtimeSessionId);
      const transcriptPath = findSessionTranscript(runtimeSessionId);
      expect(
        transcriptPath,
        "seed session JSONL must exist under ~/.claude/projects",
      ).toBeDefined();
      const seedLinesBefore = transcriptLineCount(transcriptPath as string);

      const session = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId,
        status: "idle",
        metadata: { directory: dir, transcriptPath },
      });

      process.env.ARCS_CLAUDE_RUN_TIMEOUT_MS = String(RUN_TIMEOUT_MS);

      let server: WebServerHandle | null = null;
      try {
        server = await startWebServer({ port: 0, host: "127.0.0.1", watch: false });

        // 1. The route answers 202 immediately — the run proceeds out-of-band —
        //    and names the record it forked the observed session into.
        const runRes = await fetch(
          `${server.url}/api/p/demo/sessions/${session.normalizedId}/turns`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-ARCS-Token": currentWebToken() ?? "",
            },
            body: JSON.stringify({ intent: "ask", message: RUN_MESSAGE }),
          },
        );
        expect(runRes.status).toBe(202);
        const runEnvelope = (await runRes.json()) as {
          ok: boolean;
          data?: { runId?: string; streamUrl?: string; writeTargetId?: string };
        };
        expect(runEnvelope.ok).toBe(true);
        const runId = runEnvelope.data?.runId as string;
        const writeTargetId = runEnvelope.data?.writeTargetId as string;
        expect(runId).toBeTypeOf("string");
        // Adoption forks: the write target is a NEW ARCS thread, never the
        // observed record the turn was addressed to.
        expect(writeTargetId).toMatch(/^arcs-thread-demo-/);
        expect(writeTargetId).not.toBe(session.normalizedId);
        expect(runEnvelope.data?.streamUrl).toBe(
          `/api/p/demo/sessions/${writeTargetId}/runs/${runId}/stream`,
        );

        // 2. The run completes: metadata.run finalizes with a terminal outcome
        //    on the WRITE TARGET, carrying the turn's intent.
        const { run } = await waitForRunSettled(server.url, writeTargetId, POLL_DEADLINE_MS);
        expect(run.outcome).toBe("success");
        expect(run.mode).toBe("ask");
        expect(typeof run.endedAt).toBe("number");
        expect(run.replyChars).toBeGreaterThan(0);

        // 3. The fork's own sidecar: the request-time user turn, then the
        //    assistant reply the settle folded down (exact text loose).
        const trRes = await fetch(`${server.url}/api/p/demo/sessions/${writeTargetId}/transcript`);
        expect(trRes.status).toBe(200);
        const trEnvelope = (await trRes.json()) as {
          ok: boolean;
          data?: { turns: Turn[]; mirroredAt: string | null };
        };
        const turns = trEnvelope.data?.turns ?? [];
        const userIdx = turns.findIndex((t) => t.type === "user" && t.text === RUN_MESSAGE);
        expect(
          userIdx,
          "the turn's user prompt must be on the fork's sidecar",
        ).toBeGreaterThanOrEqual(0);
        const assistantAfter = turns
          .slice(userIdx + 1)
          .find((t) => t.type === "assistant" && t.text.trim().length > 0);
        expect(
          assistantAfter,
          "an assistant turn with the reply text must follow the user turn",
        ).toBeDefined();

        // 4. THE SAFETY PROPERTY. The observed session's transcript did not
        //    grow, and its record holds no claim — a fork that landed in place
        //    would have appended to the human's live thread with exit 0 and an
        //    empty stderr, which is exactly why this is measured rather than
        //    trusted.
        expect(transcriptLineCount(transcriptPath as string)).toBe(seedLinesBefore);
        const observedRes = await fetch(
          `${server.url}/api/p/demo/sessions/${session.normalizedId}`,
        );
        const observed = (await observedRes.json()) as SessionEnvelope;
        expect(observed.data?.metadata?.run).toBeUndefined();
      } finally {
        await server?.close();
      }
    });
  },
  180_000, // real claude seed + fork + settle routinely exceed vitest's 5s default
);
