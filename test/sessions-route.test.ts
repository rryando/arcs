/**
 * Session route tests — the transcript read-model and session deletion.
 *
 * Prompt delivery lives on `POST /sessions/:id/turns` and is covered by
 * test/sessions-route-run.test.ts; what remains here is everything the routes
 * answer from the store and the transcript sidecar alone.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendReferenceTurn,
  mirrorSessionTranscript,
  readSessionTurns,
  sessionTranscriptPath,
} from "../src/utils/claude-transcript.js";
import { createSession, getSession } from "../src/utils/session-store.js";
import { startWebServer, type WebServerHandle } from "../src/web-server/index.js";
import { currentWebToken } from "../src/web-server/web-token.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

interface Ctx {
  base: string;
  projectDir: string;
}

async function withRouteCtx(run: (ctx: Ctx) => Promise<void>): Promise<void> {
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
        description: "test project",
        createdAt: "2026-01-01T00:00:00.000Z",
        workspacePaths: [],
      }),
      "utf-8",
    );

    let server: WebServerHandle | null = null;
    try {
      server = await startWebServer({ port: 0, host: "127.0.0.1", watch: false });
      await run({ base: server.url, projectDir });
    } finally {
      await server?.close();
    }
  });
}

/**
 * A reference turn exactly as ARCS wrote it BEFORE the reference union existed:
 * the doc shape, carrying no variant tag anywhere. Sidecars full of these lines
 * are already on disk, so the read path is pinned against parsing them
 * unchanged.
 */
const LEGACY_REFERENCE_LINE =
  '{"id":-1,"type":"reference","text":"Queue drain happens at the next hook checkpoint.",' +
  '"ts":"2026-01-01T00:00:00.000Z","section":{"depth":1,"text":"The session drains the queue ' +
  'at the next hook checkpoint.","id":"sec_1","startOffset":120,"endOffset":220},' +
  '"source":{"kind":"knowledge","label":"session-bridge","doc":"docs/bridge.md","id":"k_1"}}';

describe("GET /api/p/:slug/sessions/:id/transcript", () => {
  it("404s for a session the project does not have", async () => {
    await withRouteCtx(async ({ base }) => {
      const res = await fetch(`${base}/api/p/demo/sessions/ses-missing/transcript`);
      expect(res.status).toBe(404);
      const envelope = (await res.json()) as { ok: boolean; code?: string };
      expect(envelope.ok).toBe(false);
      expect(envelope.code).toBe("ITEM_NOT_FOUND");
    });
  });

  it("answers an empty transcript with mirroredAt null before any mirror exists", async () => {
    await withRouteCtx(async ({ base, projectDir }) => {
      const session = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_tr_empty",
      });

      const res = await fetch(`${base}/api/p/demo/sessions/${session.normalizedId}/transcript`);
      expect(res.status).toBe(200);
      const envelope = (await res.json()) as {
        ok: boolean;
        data?: { turns: unknown[]; mirroredAt: string | null };
      };
      expect(envelope.ok).toBe(true);
      expect(envelope.data).toEqual({ turns: [], mirroredAt: null });
    });
  });

  it("roundtrips mirrored and reference turns with the sidecar mtime", async () => {
    await withRouteCtx(async ({ base, projectDir }) => {
      const session = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_tr_rt",
      });

      // A Claude Code transcript source, then mirror + append a reference.
      const sourcePath = resolve(projectDir, "sessions", "cc_tr_rt.source.jsonl");
      writeFileSync(
        sourcePath,
        [
          JSON.stringify({
            type: "user",
            message: { role: "user", content: "first question" },
            timestamp: "2026-01-01T00:00:00.000Z",
          }),
          JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "first answer" }],
            },
            timestamp: "2026-01-01T00:00:01.000Z",
          }),
          "",
        ].join("\n"),
        "utf-8",
      );
      await mirrorSessionTranscript(projectDir, session.normalizedId, sourcePath);
      await appendReferenceTurn(projectDir, session.normalizedId, { text: "quoted reference" });

      const res = await fetch(`${base}/api/p/demo/sessions/${session.normalizedId}/transcript`);
      expect(res.status).toBe(200);
      const envelope = (await res.json()) as {
        ok: boolean;
        data?: {
          turns: Array<{ id: number; type: string; text: string; ts?: string }>;
          mirroredAt: string | null;
        };
      };
      expect(envelope.ok).toBe(true);
      expect(envelope.data?.turns).toEqual([
        {
          id: 0,
          type: "user",
          text: "first question",
          ts: "2026-01-01T00:00:00.000Z",
        },
        {
          id: 1,
          type: "assistant",
          text: "first answer",
          ts: "2026-01-01T00:00:01.000Z",
        },
        expect.objectContaining({ id: -1, type: "reference", text: "quoted reference" }),
      ]);
      expect(typeof envelope.data?.mirroredAt).toBe("string");
    });
  });

  it("still reads a doc reference turn written before the union existed", async () => {
    await withRouteCtx(async ({ base, projectDir }) => {
      const session = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_ref_legacy",
      });
      mkdirSync(resolve(projectDir, "sessions"), { recursive: true });
      writeFileSync(
        sessionTranscriptPath(projectDir, session.normalizedId),
        `${LEGACY_REFERENCE_LINE}\n`,
        "utf-8",
      );

      // Parses off disk unchanged, and reaches the read-model intact.
      expect(await readSessionTurns(projectDir, session.normalizedId)).toEqual([
        JSON.parse(LEGACY_REFERENCE_LINE),
      ]);
      const res = await fetch(`${base}/api/p/demo/sessions/${session.normalizedId}/transcript`);
      const envelope = (await res.json()) as { ok: boolean; data?: { turns: unknown[] } };
      expect(envelope.ok).toBe(true);
      expect(envelope.data?.turns).toEqual([JSON.parse(LEGACY_REFERENCE_LINE)]);
    });
  });
});

describe("DELETE /api/p/:slug/sessions/:id", () => {
  it("removes the transcript sidecar when the session is deleted", async () => {
    await withRouteCtx(async ({ base, projectDir }) => {
      const session = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_del_1",
      });
      await appendReferenceTurn(projectDir, session.normalizedId, { text: "about to vanish" });
      const sidecar = sessionTranscriptPath(projectDir, session.normalizedId);
      expect(existsSync(sidecar)).toBe(true);

      const res = await fetch(`${base}/api/p/demo/sessions/${session.normalizedId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "X-ARCS-Token": currentWebToken() ?? "" },
      });
      expect(res.status).toBe(200);
      const envelope = (await res.json()) as { ok: boolean; data?: { deleted: boolean } };
      expect(envelope.ok).toBe(true);
      expect(envelope.data).toEqual({ deleted: true });

      expect(existsSync(sidecar)).toBe(false);
      await expect(getSession(projectDir, session.normalizedId)).rejects.toThrow();
    });
  });

  it("still deletes a session when no sidecar exists", async () => {
    await withRouteCtx(async ({ base, projectDir }) => {
      const session = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "cc_del_2",
      });

      const res = await fetch(`${base}/api/p/demo/sessions/${session.normalizedId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "X-ARCS-Token": currentWebToken() ?? "" },
      });
      expect(res.status).toBe(200);
      const envelope = (await res.json()) as { ok: boolean; data?: { deleted: boolean } };
      expect(envelope.ok).toBe(true);
      expect(envelope.data).toEqual({ deleted: true });
      await expect(getSession(projectDir, session.normalizedId)).rejects.toThrow();
    });
  });

  it("removes the sidecar by normalizedId when the route id is not slugified", async () => {
    await withRouteCtx(async ({ base, projectDir }) => {
      // "Delete Me 1" normalizes to "delete-me-1": the route id differs from
      // the normalized sidecar filename key, so the unlink must key on
      // session.normalizedId rather than the raw id.
      const session = await createSession(projectDir, {
        runtimeType: "claude-code",
        runtimeSessionId: "Delete Me 1",
      });
      expect(session.normalizedId).toBe("delete-me-1");
      await appendReferenceTurn(projectDir, session.normalizedId, { text: "about to vanish" });
      const sidecar = sessionTranscriptPath(projectDir, session.normalizedId);
      expect(existsSync(sidecar)).toBe(true);

      const res = await fetch(`${base}/api/p/demo/sessions/${encodeURIComponent("Delete Me 1")}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "X-ARCS-Token": currentWebToken() ?? "" },
      });
      expect(res.status).toBe(200);
      const envelope = (await res.json()) as { ok: boolean; data?: { deleted: boolean } };
      expect(envelope.ok).toBe(true);
      expect(envelope.data).toEqual({ deleted: true });

      expect(existsSync(sidecar)).toBe(false);
      await expect(getSession(projectDir, "Delete Me 1")).rejects.toThrow();
    });
  });
});
