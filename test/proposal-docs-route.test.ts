// ---------------------------------------------------------------------------
// proposal-docs web routes — data-dir plane: list/get/PUT/promote for the
// human-in-the-loop proposal documents (proposals/*.proposal.md|*.accepted.md)
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getProjectDir } from "../src/utils/paths.js";
import { createPlan, readPlanIndex } from "../src/utils/plan-store.js";
import { startWebServer, type WebServerHandle } from "../src/web-server/index.js";
import { currentWebToken } from "../src/web-server/web-token.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

const SLUG = "demo";

interface Envelope {
  ok: boolean;
  code?: string;
  message?: string;
  data?: unknown;
}

interface Ctx {
  base: string;
  projectDir: string;
  proposalsDir: string;
}

async function request(
  base: string,
  method: "GET" | "PUT" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; envelope: Envelope }> {
  const res = await fetch(`${base}${path}`, {
    method,
    ...(method === "GET"
      ? {}
      : {
          headers: {
            "Content-Type": "application/json",
            "X-ARCS-Token": currentWebToken() ?? "",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
  });
  return { status: res.status, envelope: (await res.json()) as Envelope };
}

async function withRouteCtx(run: (ctx: Ctx) => Promise<void>): Promise<void> {
  await withTempDataDir(async (dir) => {
    // Re-register the project in root meta so requireProjectDir resolves it.
    writeFileSync(
      resolve(dir, "meta.json"),
      JSON.stringify({
        version: "1.0",
        projects: [{ id: SLUG, name: "Demo", status: "active", dependsOn: [] }],
      }),
      "utf-8",
    );
    const projectDir = getProjectDir(SLUG);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      resolve(projectDir, "meta.json"),
      JSON.stringify({
        id: SLUG,
        name: "Demo",
        description: "test project",
        createdAt: "2026-01-01T00:00:00.000Z",
        workspacePaths: [],
      }),
      "utf-8",
    );
    const proposalsDir = join(projectDir, "proposals");

    let server: WebServerHandle | null = null;
    try {
      server = await startWebServer({ port: 0, host: "127.0.0.1", watch: false });
      await run({ base: server.url, projectDir, proposalsDir });
    } finally {
      await server?.close();
    }
  });
}

const DOC_BODY = `# Big Redesign

## Motivation

Do the thing.
`;

function seedDoc(proposalsDir: string, fileName: string, body: string): void {
  mkdirSync(proposalsDir, { recursive: true });
  writeFileSync(join(proposalsDir, fileName), body, "utf-8");
}

// ---------------------------------------------------------------------------
// GET /api/p/:slug/proposal-docs
// ---------------------------------------------------------------------------

describe("GET /api/p/:slug/proposal-docs", () => {
  it("answers an empty list with zeroed counts when no docs exist", async () => {
    await withRouteCtx(async ({ base }) => {
      const { status, envelope } = await request(base, "GET", `/api/p/${SLUG}/proposal-docs`);
      expect(status).toBe(200);
      expect(envelope.ok).toBe(true);
      expect(envelope.data).toEqual({
        proposalDocs: [],
        counts: { pending: 0, accepted: 0 },
      });
    });
  });

  it("lists pending docs with derived titles and hides accepted docs from the list", async () => {
    await withRouteCtx(async ({ base, proposalsDir }) => {
      seedDoc(proposalsDir, "alpha-plan.proposal.md", DOC_BODY);
      seedDoc(proposalsDir, "older-plan.accepted.md", "# Older Plan\n");
      // The codegraph queue cohabits in proposals/ and must never leak in.
      seedDoc(proposalsDir, "codegraph.json", "{}");

      const { status, envelope } = await request(base, "GET", `/api/p/${SLUG}/proposal-docs`);
      expect(status).toBe(200);
      const data = envelope.data as {
        proposalDocs: {
          id: string;
          title: string;
          status: string;
          path: string;
          updatedAt: string | null;
        }[];
        counts: { pending: number; accepted: number };
      };
      expect(data.proposalDocs).toHaveLength(1);
      expect(data.proposalDocs[0]).toMatchObject({
        id: "alpha-plan",
        title: "Big Redesign",
        status: "pending",
        path: "proposals/alpha-plan.proposal.md",
      });
      expect(typeof data.proposalDocs[0]?.updatedAt).toBe("string");
      expect(data.counts).toEqual({ pending: 1, accepted: 1 });
    });
  });
});

// ---------------------------------------------------------------------------
// GET /api/p/:slug/proposal-docs/:id
// ---------------------------------------------------------------------------

describe("GET /api/p/:slug/proposal-docs/:id", () => {
  it("returns a pending doc body", async () => {
    await withRouteCtx(async ({ base, proposalsDir }) => {
      seedDoc(proposalsDir, "alpha-plan.proposal.md", DOC_BODY);

      const { status, envelope } = await request(
        base,
        "GET",
        `/api/p/${SLUG}/proposal-docs/alpha-plan`,
      );
      expect(status).toBe(200);
      expect(envelope.data).toMatchObject({
        id: "alpha-plan",
        status: "pending",
        path: "proposals/alpha-plan.proposal.md",
        title: "Big Redesign",
        body: DOC_BODY,
      });
    });
  });

  it("falls back to the accepted doc when the pending file is gone", async () => {
    await withRouteCtx(async ({ base, proposalsDir }) => {
      seedDoc(proposalsDir, "alpha-plan.accepted.md", DOC_BODY);

      const { status, envelope } = await request(
        base,
        "GET",
        `/api/p/${SLUG}/proposal-docs/alpha-plan`,
      );
      expect(status).toBe(200);
      expect(envelope.data).toMatchObject({
        id: "alpha-plan",
        status: "accepted",
        path: "proposals/alpha-plan.accepted.md",
        body: DOC_BODY,
      });
    });
  });

  it("404s when neither pending nor accepted exists", async () => {
    await withRouteCtx(async ({ base }) => {
      const { status, envelope } = await request(
        base,
        "GET",
        `/api/p/${SLUG}/proposal-docs/missing-doc`,
      );
      expect(status).toBe(404);
      expect(envelope.ok).toBe(false);
      expect(envelope.code).toBe("ENTITY_NOT_FOUND");
    });
  });
});

// ---------------------------------------------------------------------------
// PUT /api/p/:slug/proposal-docs/:id
// ---------------------------------------------------------------------------

describe("PUT /api/p/:slug/proposal-docs/:id", () => {
  it("roundtrips content into a pending doc", async () => {
    await withRouteCtx(async ({ base, proposalsDir }) => {
      seedDoc(proposalsDir, "alpha-plan.proposal.md", DOC_BODY);

      const replacement = "# Rewritten\n\nNew body.\n";
      const put = await request(base, "PUT", `/api/p/${SLUG}/proposal-docs/alpha-plan`, {
        content: replacement,
      });
      expect(put.status).toBe(200);
      expect(put.envelope.data).toMatchObject({
        id: "alpha-plan",
        status: "pending",
        path: "proposals/alpha-plan.proposal.md",
        updated: true,
      });

      const onDisk = await readFile(join(proposalsDir, "alpha-plan.proposal.md"), "utf-8");
      expect(onDisk).toBe(replacement);
    });
  });

  it("404s with a read-only message when only the accepted doc exists", async () => {
    await withRouteCtx(async ({ base, proposalsDir }) => {
      seedDoc(proposalsDir, "alpha-plan.accepted.md", DOC_BODY);

      const put = await request(base, "PUT", `/api/p/${SLUG}/proposal-docs/alpha-plan`, {
        content: "# nope\n",
      });
      expect(put.status).toBe(404);
      expect(put.envelope.ok).toBe(false);
      expect(put.envelope.code).toBe("ENTITY_NOT_FOUND");
      expect(put.envelope.message).toContain("accepted proposal docs are read-only");
    });
  });

  it("creates the proposals dir when missing (first save)", async () => {
    await withRouteCtx(async ({ base, proposalsDir }) => {
      const put = await request(base, "PUT", `/api/p/${SLUG}/proposal-docs/fresh-doc`, {
        content: "# Fresh\n",
      });
      expect(put.status).toBe(200);

      const onDisk = await readFile(join(proposalsDir, "fresh-doc.proposal.md"), "utf-8");
      expect(onDisk).toBe("# Fresh\n");
    });
  });

  it("rejects a body without content", async () => {
    await withRouteCtx(async ({ base }) => {
      const put = await request(base, "PUT", `/api/p/${SLUG}/proposal-docs/alpha-plan`, {});
      expect(put.status).toBe(400);
      expect(put.envelope.code).toBe("INVALID_BODY");
    });
  });
});

// ---------------------------------------------------------------------------
// POST /api/p/:slug/proposal-docs/:id/promote
// ---------------------------------------------------------------------------

describe("POST /api/p/:slug/proposal-docs/:id/promote", () => {
  it("renames the doc, creates the plan, and returns the plan payload", async () => {
    await withRouteCtx(async ({ base, projectDir, proposalsDir }) => {
      seedDoc(proposalsDir, "alpha-plan.proposal.md", DOC_BODY);

      const { status, envelope } = await request(
        base,
        "POST",
        `/api/p/${SLUG}/proposal-docs/alpha-plan/promote`,
      );
      expect(status).toBe(200);
      const data = envelope.data as {
        promoted: boolean;
        plan: { id: string; title: string; status: string; file: string };
        docPath: string;
      };
      expect(data.promoted).toBe(true);
      expect(data.docPath).toBe("proposals/alpha-plan.accepted.md");
      expect(data.plan).toMatchObject({ id: "big-redesign", title: "Big Redesign" });

      // The rename landed and the plan is readable via the plan index.
      const bodyOnDisk = await readFile(join(proposalsDir, "alpha-plan.accepted.md"), "utf-8");
      expect(bodyOnDisk).toBe(DOC_BODY);
      const { plans } = await readPlanIndex(projectDir);
      expect(plans).toHaveLength(1);
      expect(plans[0]).toMatchObject({ id: "big-redesign", title: "Big Redesign" });
    });
  });

  it("recovers promotion from the accepted doc when no plan exists yet", async () => {
    await withRouteCtx(async ({ base, projectDir, proposalsDir }) => {
      seedDoc(proposalsDir, "alpha-plan.accepted.md", DOC_BODY);

      const { status, envelope } = await request(
        base,
        "POST",
        `/api/p/${SLUG}/proposal-docs/alpha-plan/promote`,
      );
      expect(status).toBe(200);
      const data = envelope.data as {
        promoted: boolean;
        recovered?: boolean;
        plan: { id: string };
      };
      expect(data.promoted).toBe(true);
      expect(data.recovered).toBe(true);
      expect(data.plan.id).toBe("big-redesign");

      const { plans } = await readPlanIndex(projectDir);
      expect(plans.map((p) => p.id)).toEqual(["big-redesign"]);
    });
  });

  it("409-conflicts when the derived plan already exists", async () => {
    await withRouteCtx(async ({ base, projectDir, proposalsDir }) => {
      seedDoc(proposalsDir, "alpha-plan.proposal.md", DOC_BODY);
      // The plan the promote would derive, already in the store.
      await createPlan(projectDir, {
        id: "big-redesign",
        title: "Big Redesign",
        status: "proposed",
        keywords: [],
      });

      const { status, envelope } = await request(
        base,
        "POST",
        `/api/p/${SLUG}/proposal-docs/alpha-plan/promote`,
      );
      // PLAN_CONFLICT is in CONFLICT_CODES, so it maps to HTTP 409.
      expect(status).toBe(409);
      expect(envelope.code).toBe("PLAN_CONFLICT");

      // The doc must remain pending — no rename happened.
      const pending = await readFile(join(proposalsDir, "alpha-plan.proposal.md"), "utf-8");
      expect(pending).toBe(DOC_BODY);
    });
  });

  it("rolls the rename back when plan creation fails", async () => {
    await withRouteCtx(async ({ base, projectDir, proposalsDir }) => {
      seedDoc(proposalsDir, "alpha-plan.proposal.md", DOC_BODY);
      // Sabotage plan creation without breaking the plan index: the plan's
      // body path is a directory, so createPlan's transaction fails on the
      // body write — after the route has already renamed the doc.
      const plansDir = join(projectDir, "plans");
      mkdirSync(join(plansDir, "big-redesign.md"), { recursive: true });

      const { status, envelope } = await request(
        base,
        "POST",
        `/api/p/${SLUG}/proposal-docs/alpha-plan/promote`,
      );
      expect(status).toBe(500);
      expect(envelope.ok).toBe(false);

      // The rename was rolled back: the doc is pending again and the
      // aborted accepted copy is gone.
      const pending = await readFile(join(proposalsDir, "alpha-plan.proposal.md"), "utf-8");
      expect(pending).toBe(DOC_BODY);
      const accepted = await readFile(join(proposalsDir, "alpha-plan.accepted.md"), "utf-8").catch(
        () => null,
      );
      expect(accepted).toBeNull();
    });
  });

  it("404s when neither pending nor accepted exists", async () => {
    await withRouteCtx(async ({ base }) => {
      const { status, envelope } = await request(
        base,
        "POST",
        `/api/p/${SLUG}/proposal-docs/missing-doc/promote`,
      );
      expect(status).toBe(404);
      expect(envelope.code).toBe("ENTITY_NOT_FOUND");
    });
  });
});
