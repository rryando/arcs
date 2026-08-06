/**
 * Read-only workspace file plane — tree + file routes and their containment guard.
 *
 * The load-bearing cases are the three escape attempts: `../` traversal, an
 * absolute path outside the root, and a symlink inside the root pointing out of
 * it. Each asserts on the RAW response body, not just the status — a 400 that
 * still carries the file's bytes is a leak, and a status-only assertion would
 * pass straight through it. Every escape target holds the same marker string, so
 * one `not.toContain` per case proves nothing crossed the boundary.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { startWebServer, type WebServerHandle } from "../src/web-server/index.js";
import {
  WORKSPACE_FILE_MAX_BYTES,
  WORKSPACE_TREE_MAX_DEPTH,
  WORKSPACE_TREE_MAX_ENTRIES,
} from "../src/web-server/routes/workspace.js";
import { currentWebToken } from "../src/web-server/web-token.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

/** Present in every file the guard must never surface. */
const SECRET_MARKER = "TOP-SECRET-OUTSIDE-THE-ROOT-9f3a17";

interface Ctx {
  base: string;
  /** The registered workspace root, realpath'd exactly as the server sees it. */
  workspace: string;
  /** A sibling directory OUTSIDE the root, holding the escape targets. */
  outside: string;
}

interface Envelope {
  ok: boolean;
  code?: string;
  message?: string;
  data?: unknown;
}

interface Fetched {
  status: number;
  /** The bytes as they went over the wire — what the leak assertions read. */
  raw: string;
  envelope: Envelope | null;
}

async function get(base: string, path: string): Promise<Fetched> {
  const res = await fetch(`${base}${path}`);
  const raw = await res.text();
  let envelope: Envelope | null = null;
  try {
    envelope = JSON.parse(raw) as Envelope;
  } catch {
    envelope = null;
  }
  return { status: res.status, raw, envelope };
}

interface SeedOptions {
  /** Registered workspacePaths; omitted means `[<temp>/workspace]`. */
  workspacePaths?: string[];
  /** Extra files, keyed by path relative to the workspace root. */
  files?: Record<string, string>;
  /** Runs before the server boots, with the workspace + outside dirs in place. */
  prepare?: (ctx: { workspace: string; outside: string }) => void;
}

async function withWorkspace(
  run: (ctx: Ctx) => Promise<void>,
  options: SeedOptions = {},
): Promise<void> {
  await withTempDataDir(async (dir) => {
    const workspace = resolve(dir, "workspace");
    const outside = resolve(dir, "outside");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });

    // The escape targets. Both exist, so a failing guard would return real
    // bytes rather than an incidental ENOENT.
    writeFileSync(resolve(outside, "secret.txt"), `${SECRET_MARKER}\n`, "utf-8");
    writeFileSync(resolve(outside, "nested.txt"), `${SECRET_MARKER} nested\n`, "utf-8");

    writeFileSync(resolve(workspace, "hello.txt"), "alpha\nbeta\ngamma\n", "utf-8");
    mkdirSync(resolve(workspace, "src"), { recursive: true });
    writeFileSync(resolve(workspace, "src", "index.ts"), "export const x = 1;\n", "utf-8");
    for (const [relPath, content] of Object.entries(options.files ?? {})) {
      const target = resolve(workspace, relPath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf-8");
    }
    options.prepare?.({ workspace, outside });

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
        workspacePaths: options.workspacePaths ?? [workspace],
      }),
      "utf-8",
    );

    let server: WebServerHandle | null = null;
    try {
      server = await startWebServer({ port: 0, host: "127.0.0.1", watch: false });
      await run({ base: server.url, workspace: realpathSync(workspace), outside });
    } finally {
      await server?.close();
    }
  });
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("GET /api/p/:slug/workspace/tree", () => {
  it("lists the registered workspace root, directories first", async () => {
    await withWorkspace(async ({ base, workspace }) => {
      const { status, envelope } = await get(base, "/api/p/demo/workspace/tree");
      expect(status).toBe(200);

      const data = envelope?.data as {
        root: string;
        path: string;
        truncated: boolean;
        entries: { name: string; path: string; type: string }[];
      };
      // Realpath'd: on a platform whose tmpdir is itself a symlink the served
      // root is the resolved one, never the configured string.
      expect(data.root).toBe(workspace);
      expect(data.path).toBe("");
      expect(data.truncated).toBe(false);
      expect(data.entries.map((e) => `${e.type} ${e.path}`)).toEqual(["dir src", "file hello.txt"]);
    });
  });

  it("descends into a subdirectory and reports root-relative paths", async () => {
    await withWorkspace(async ({ base }) => {
      const { status, envelope } = await get(base, "/api/p/demo/workspace/tree?path=src");
      expect(status).toBe(200);
      const data = envelope?.data as { path: string; entries: { path: string }[] };
      expect(data.path).toBe("src");
      expect(data.entries.map((e) => e.path)).toEqual(["src/index.ts"]);
    });
  });

  it("caps depth and entry count instead of walking an unbounded tree", async () => {
    const files: Record<string, string> = {};
    // Deeper than the depth cap, and wider than the entry cap at one level.
    let deep = "deep";
    for (let i = 0; i < WORKSPACE_TREE_MAX_DEPTH + 3; i += 1) {
      deep = `${deep}/d${i}`;
      files[`${deep}/leaf.txt`] = "x";
    }
    for (let i = 0; i < WORKSPACE_TREE_MAX_ENTRIES + 25; i += 1) {
      files[`wide/f${String(i).padStart(5, "0")}.txt`] = "x";
    }

    await withWorkspace(
      async ({ base }) => {
        const wide = await get(base, "/api/p/demo/workspace/tree?path=wide");
        const wideData = wide.envelope?.data as { truncated: boolean; entries: unknown[] };
        expect(wideData.entries.length).toBe(WORKSPACE_TREE_MAX_ENTRIES);
        expect(wideData.truncated).toBe(true);

        // A depth far past the cap is clamped, never honoured.
        const deepRes = await get(base, "/api/p/demo/workspace/tree?path=deep&depth=99");
        const deepData = deepRes.envelope?.data as { depth: number; entries: { path: string }[] };
        expect(deepData.depth).toBe(WORKSPACE_TREE_MAX_DEPTH);
        const deepest = deepData.entries.reduce(
          (max, e) => Math.max(max, e.path.split("/").length),
          0,
        );
        // Root-relative paths start at `deep/`, so the deepest segment count is
        // the requested prefix (1) plus the clamped depth.
        expect(deepest).toBe(1 + WORKSPACE_TREE_MAX_DEPTH);
      },
      { files },
    );
  });
});

describe("GET /api/p/:slug/workspace/file", () => {
  it("returns the file's text, line count and the head revision", async () => {
    await withWorkspace(async ({ base }) => {
      const { status, envelope } = await get(base, "/api/p/demo/workspace/file?path=hello.txt");
      expect(status).toBe(200);
      const data = envelope?.data as {
        path: string;
        content: string;
        lineCount: number;
        size: number;
        truncated: boolean;
        headRev: string | null;
      };
      expect(data.path).toBe("hello.txt");
      expect(data.content).toBe("alpha\nbeta\ngamma\n");
      expect(data.lineCount).toBe(3);
      expect(data.truncated).toBe(false);
      expect(data.size).toBe(17);
      // Non-repo workspace: the field is present and explicitly null, so a
      // caller building a `file` ref can always read it.
      expect(data.headRev).toBeNull();
    });
  });

  it("carries the current head revision when the workspace is a git repo", async () => {
    await withWorkspace(
      async ({ base }) => {
        const { status, envelope } = await get(base, "/api/p/demo/workspace/file?path=hello.txt");
        expect(status).toBe(200);
        const { headRev } = envelope?.data as { headRev: string | null };
        expect(headRev).toMatch(/^[0-9a-f]{7,40}$/);
      },
      {
        prepare: ({ workspace }) => {
          const git = (...args: string[]) =>
            execFileSync("git", args, { cwd: workspace, stdio: "ignore" });
          git("init", "-q");
          git(
            "-c",
            "user.email=t@example.com",
            "-c",
            "user.name=T",
            "commit",
            "-q",
            "-m",
            "seed",
            "--allow-empty",
          );
        },
      },
    );
  });

  it("caps the response and flags it truncated instead of streaming a huge file", async () => {
    const big = "x".repeat(WORKSPACE_FILE_MAX_BYTES + 4096);
    await withWorkspace(
      async ({ base }) => {
        const { status, envelope } = await get(base, "/api/p/demo/workspace/file?path=big.txt");
        expect(status).toBe(200);
        const data = envelope?.data as { content: string; truncated: boolean; size: number };
        expect(data.truncated).toBe(true);
        expect(data.content.length).toBe(WORKSPACE_FILE_MAX_BYTES);
        expect(data.size).toBe(big.length);
      },
      { files: { "big.txt": big } },
    );
  });

  it("404s a missing file inside the root, without inventing content", async () => {
    await withWorkspace(async ({ base }) => {
      const { status, envelope } = await get(base, "/api/p/demo/workspace/file?path=nope.txt");
      expect(status).toBe(404);
      expect(envelope?.ok).toBe(false);
      expect(envelope?.code).toBe("WORKSPACE_PATH_NOT_FOUND");
      expect(envelope?.data).toBeUndefined();
    });
  });

  it("refuses a directory and a path-less request", async () => {
    await withWorkspace(async ({ base }) => {
      const dirRes = await get(base, "/api/p/demo/workspace/file?path=src");
      expect(dirRes.status).toBe(400);
      expect(dirRes.envelope?.code).toBe("WORKSPACE_NOT_A_FILE");

      const bare = await get(base, "/api/p/demo/workspace/file");
      expect(bare.status).toBe(400);
      expect(bare.envelope?.code).toBe("WORKSPACE_PATH_REQUIRED");
    });
  });
});

// ---------------------------------------------------------------------------
// Containment guard — the three escapes
// ---------------------------------------------------------------------------

describe("workspace containment guard", () => {
  it("refuses `../` traversal with 400 and leaks no bytes", async () => {
    await withWorkspace(async ({ base }) => {
      for (const path of ["../outside/secret.txt", "src/../../outside/secret.txt"]) {
        const { status, raw, envelope } = await get(
          base,
          `/api/p/demo/workspace/file?path=${encodeURIComponent(path)}`,
        );
        expect({ path, status }).toEqual({ path, status: 400 });
        expect(envelope?.code).toBe("WORKSPACE_PATH_FORBIDDEN");
        expect(envelope?.ok).toBe(false);
        // The leak assertion: no byte of the escape target crossed the wire.
        expect(raw).not.toContain(SECRET_MARKER);
        expect(envelope?.data).toBeUndefined();
      }

      // The tree route is guarded by the same call, so it must refuse too.
      const tree = await get(base, "/api/p/demo/workspace/tree?path=..%2Foutside");
      expect(tree.status).toBe(400);
      expect(tree.envelope?.code).toBe("WORKSPACE_PATH_FORBIDDEN");
      expect(tree.raw).not.toContain("secret.txt");
      expect(tree.raw).not.toContain(SECRET_MARKER);
    });
  });

  it("refuses an absolute path outside the root with 400 and leaks no bytes", async () => {
    await withWorkspace(async ({ base, outside }) => {
      const absolute = resolve(outside, "secret.txt");
      const { status, raw, envelope } = await get(
        base,
        `/api/p/demo/workspace/file?path=${encodeURIComponent(absolute)}`,
      );
      expect(status).toBe(400);
      expect(envelope?.code).toBe("WORKSPACE_PATH_FORBIDDEN");
      expect(raw).not.toContain(SECRET_MARKER);
      expect(envelope?.data).toBeUndefined();

      // A path that is absolute AND real but belongs to the host, not the
      // project: same refusal, same silence.
      const etc = await get(base, "/api/p/demo/workspace/file?path=%2Fetc%2Fhosts");
      expect(etc.status).toBe(400);
      expect(etc.envelope?.code).toBe("WORKSPACE_PATH_FORBIDDEN");
      expect(etc.raw).not.toContain("localhost");

      const tree = await get(
        base,
        `/api/p/demo/workspace/tree?path=${encodeURIComponent(outside)}`,
      );
      expect(tree.status).toBe(400);
      expect(tree.raw).not.toContain("secret.txt");
    });
  });

  it("refuses a symlink inside the root that points outside it, with 400 and no bytes", async () => {
    await withWorkspace(
      async ({ base }) => {
        // A string-first guard passes this: `escape.txt` is lexically inside the
        // root. Only resolving BEFORE containing catches it.
        const file = await get(base, "/api/p/demo/workspace/file?path=escape.txt");
        expect(file.status).toBe(400);
        expect(file.envelope?.code).toBe("WORKSPACE_PATH_FORBIDDEN");
        expect(file.raw).not.toContain(SECRET_MARKER);
        expect(file.envelope?.data).toBeUndefined();

        // Same for a file reached THROUGH a symlinked directory.
        const through = await get(base, "/api/p/demo/workspace/file?path=escape-dir%2Fnested.txt");
        expect(through.status).toBe(400);
        expect(through.envelope?.code).toBe("WORKSPACE_PATH_FORBIDDEN");
        expect(through.raw).not.toContain(SECRET_MARKER);

        // ...and the tree must neither descend into it nor advertise it.
        const escapeTree = await get(base, "/api/p/demo/workspace/tree?path=escape-dir");
        expect(escapeTree.status).toBe(400);
        expect(escapeTree.raw).not.toContain("nested.txt");
        expect(escapeTree.raw).not.toContain(SECRET_MARKER);

        const rootTree = await get(base, "/api/p/demo/workspace/tree");
        const names = (rootTree.envelope?.data as { entries: { name: string }[] }).entries.map(
          (e) => e.name,
        );
        expect(names).not.toContain("escape.txt");
        expect(names).not.toContain("escape-dir");
      },
      {
        prepare: ({ workspace, outside }) => {
          symlinkSync(resolve(outside, "secret.txt"), resolve(workspace, "escape.txt"));
          symlinkSync(outside, resolve(workspace, "escape-dir"), "dir");
        },
      },
    );
  });

  it("refuses every request when the project has no registered workspace path", async () => {
    await withWorkspace(
      async ({ base }) => {
        for (const path of [
          "/api/p/demo/workspace/tree",
          "/api/p/demo/workspace/file?path=hello.txt",
        ]) {
          const { status, envelope, raw } = await get(base, path);
          // An empty root must never mean "the whole filesystem".
          expect({ path, status }).toEqual({ path, status: 400 });
          expect(envelope?.code).toBe("PROJECT_WORKSPACE_UNSET");
          expect(raw).not.toContain("alpha");
        }
      },
      { workspacePaths: [] },
    );
  });
});

// ---------------------------------------------------------------------------
// Read-only plane
// ---------------------------------------------------------------------------

describe("workspace plane is read-only", () => {
  it("registers no handler for a mutating method on either route", async () => {
    await withWorkspace(async ({ base }) => {
      for (const path of ["/api/p/demo/workspace/tree", "/api/p/demo/workspace/file"]) {
        for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
          // A valid web token, so the answer proves there is no handler rather
          // than only that the mutation gate answered first.
          const res = await fetch(`${base}${path}?path=hello.txt`, {
            method,
            headers: {
              "Content-Type": "application/json",
              "X-ARCS-Token": currentWebToken() ?? "",
            },
            body: JSON.stringify({ content: "overwritten" }),
          });
          const raw = await res.text();
          expect({ path, method, status: res.status }).toEqual({ path, method, status: 404 });
          expect(raw).not.toContain("alpha");
        }
      }

      // Nothing above wrote anything.
      const after = await get(base, "/api/p/demo/workspace/file?path=hello.txt");
      expect((after.envelope?.data as { content: string }).content).toBe("alpha\nbeta\ngamma\n");
    });
  });
});
