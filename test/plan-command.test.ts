// ---------------------------------------------------------------------------
// `plan create` body input paths: --body, --body-file, --body-stdin.
//
// `--body-stdin` is the create-time peer of `plan update-body --body-stdin`
// (shared `resolveBodyInput` precedence: inline > file > stdin) and matches the
// donor cc-arcs `plan create` surface. Inline shell args mangle the tables and
// fences a real plan body carries, so the stdin route exists for exactly the
// generated bodies `proposal-doc promote` emits.
// ---------------------------------------------------------------------------

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPlanBody } from "../src/utils/plan-body.js";
import { runCommand } from "./helpers/cli-runner.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

// The in-process runner cannot pipe a real stream, so the stdin reader is
// faked; each test sets the bytes it should return.
const stdin = vi.hoisted(() => ({ body: "" }));
vi.mock("../src/utils/stdin.js", () => ({
  readStdin: async () => stdin.body,
}));

const SLUG = "testproj";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function bodyFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "arcs-plan-body-"));
  tempDirs.push(dir);
  const path = join(dir, "body.md");
  writeFileSync(path, content, "utf-8");
  return path;
}

async function createProject(): Promise<void> {
  const result = await runCommand("project init", [SLUG, "--description=Test project"]);
  expect(result.ok).toBe(true);
}

async function planBody(id: string): Promise<string> {
  const result = await runCommand("plan get", [SLUG, id, "--body"]);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  return (result.data as { body: string }).body;
}

describe("plan create --body-stdin", () => {
  it("persists a piped body and exposes it via plan get --body", async () => {
    await withTempDataDir(async () => {
      await createProject();
      stdin.body = "## Notes\n\nPiped in.\n";

      const created = await runCommand("plan create", [SLUG, "Piped Plan", "--body-stdin"]);
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const id = (created.data as { id: string }).id;

      expect(await planBody(id)).toContain("Piped in.");
    });
  });

  it("keeps a matching H1 verbatim (no second H1 prepended)", async () => {
    await withTempDataDir(async () => {
      await createProject();
      stdin.body = "# Matching Title\n\nBody from stdin.\n";

      const created = await runCommand("plan create", [SLUG, "Matching Title", "--body-stdin"]);
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const id = (created.data as { id: string }).id;

      const body = await planBody(id);
      expect(body.startsWith("# Matching Title\n")).toBe(true);
      expect(body.match(/^# /gm)).toHaveLength(1);
      expect(body).toContain("Body from stdin.");
    });
  });

  it("reports hasBody in dry-run and writes nothing", async () => {
    await withTempDataDir(async () => {
      await createProject();
      stdin.body = "anything";

      const withStdin = await runCommand("plan create", [SLUG, "Dry", "--body-stdin", "--dry-run"]);
      expect(withStdin.ok).toBe(true);
      if (!withStdin.ok) return;
      expect((withStdin.data as { wouldCreate: { hasBody: boolean } }).wouldCreate.hasBody).toBe(
        true,
      );

      const withoutBody = await runCommand("plan create", [SLUG, "Dry", "--dry-run"]);
      expect(withoutBody.ok).toBe(true);
      if (!withoutBody.ok) return;
      expect((withoutBody.data as { wouldCreate: { hasBody: boolean } }).wouldCreate.hasBody).toBe(
        false,
      );
    });
  });

  it("prefers --body inline over --body-stdin", async () => {
    await withTempDataDir(async () => {
      await createProject();
      stdin.body = "from stdin";

      const created = await runCommand("plan create", [
        SLUG,
        "Precedence",
        "--body=from inline",
        "--body-stdin",
      ]);
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const id = (created.data as { id: string }).id;

      const body = await planBody(id);
      expect(body).toContain("from inline");
      expect(body).not.toContain("from stdin");
    });
  });

  it("accepts a renderPlanBody output via --body-file without a second H1", async () => {
    await withTempDataDir(async () => {
      await createProject();
      const generated = renderPlanBody({
        title: "Promoted Plan",
        slug: SLUG,
        proposalId: "promoted-plan",
        tasks: [{ taskId: "do-it", title: "Do It", verify: "npm test" }],
      });

      const created = await runCommand("plan create", [
        SLUG,
        "Promoted Plan",
        `--body-file=${bodyFile(generated)}`,
      ]);
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const id = (created.data as { id: string }).id;

      const body = await planBody(id);
      expect(body).toBe(generated);
      expect(body.match(/^# /gm)).toHaveLength(1);
      expect(body).toContain("`proposals/promoted-plan.accepted.md`");
    });
  });

  it("still accepts --body-file (regression)", async () => {
    await withTempDataDir(async () => {
      await createProject();
      const created = await runCommand("plan create", [
        SLUG,
        "File Plan",
        `--body-file=${bodyFile("# File Plan\n\nFrom file.\n")}`,
      ]);
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(await planBody((created.data as { id: string }).id)).toContain("From file.");
    });
  });

  it("fails when --body-file points at a missing file", async () => {
    await withTempDataDir(async () => {
      await createProject();
      const result = await runCommand("plan create", [
        SLUG,
        "Missing File",
        "--body-file=/no/such/plan-body.md",
      ]);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("entity_not_found");
    });
  });
});
