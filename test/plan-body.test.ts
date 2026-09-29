// ---------------------------------------------------------------------------
// Tests for the pure promoted-plan body renderer (`src/utils/plan-body.ts`).
//
// The renderer is ARCS-native: no docRefs, no pinned revisions, no sections.
// It must stay pure and deterministic (no fs/clock) so a re-promote is
// repair-safe, and its H1 must equal the plan title so `buildBody` keeps it.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { renderPlanBody } from "../src/utils/plan-body.js";

describe("renderPlanBody", () => {
  it("leads with an H1 that matches the plan title exactly (single H1)", () => {
    const body = renderPlanBody({
      title: "Storage Move",
      slug: "demo",
      proposalId: "storage-move",
    });
    expect(body.startsWith("# Storage Move\n")).toBe(true);
    expect(body.match(/^# /gm)).toHaveLength(1);
  });

  it("renders the ## Source block naming the accepted proposal with a retrieval hint", () => {
    const body = renderPlanBody({
      title: "Storage Move",
      slug: "demo",
      proposalId: "storage-move",
    });
    expect(body).toContain("## Source");
    expect(body).toContain("- Proposal doc: `proposals/storage-move.accepted.md`");
    expect(body).toContain("`arcs proposal-doc get demo storage-move`");
  });

  it("states the plan is execution-only and that the design lives in the doc", () => {
    const body = renderPlanBody({ title: "T", slug: "s", proposalId: "p" });
    expect(body).toContain(
      "This plan is execution-only. The design lives in the accepted proposal doc",
    );
  });

  it("places an optional summary paragraph between the title and the Source block", () => {
    const body = renderPlanBody({ title: "T", slug: "s", proposalId: "p", summary: "Why now." });
    expect(body).toContain("# T\n\nWhy now.\n\n## Source");
  });

  it("omits the summary paragraph when no summary is given", () => {
    const body = renderPlanBody({ title: "T", slug: "s", proposalId: "p" });
    expect(body).toContain("# T\n\n## Source");
  });

  it("renders a placeholder (no table) when the proposal carried no task list", () => {
    const body = renderPlanBody({ title: "T", slug: "s", proposalId: "p" });
    expect(body).toContain("## Tasks");
    expect(body).not.toContain("| # | Task |");
    expect(body).toContain("No task list");
  });

  it("renders a deterministic task table from the task list", () => {
    const body = renderPlanBody({
      title: "T",
      slug: "s",
      proposalId: "p",
      tasks: [
        {
          taskId: "do-thing",
          title: "Do Thing",
          sourceFiles: [{ path: "src/a.ts", anchor: "run" }, { path: "src/b.ts" }],
          verify: "npm test",
        },
        { taskId: "second", title: "Second" },
      ],
    });
    expect(body).toContain("| # | Task | Sections | Files | Verify |");
    expect(body).toContain(
      "| 1 | Do Thing (`do-thing`) | — | `src/a.ts:run`, `src/b.ts` | `npm test` |",
    );
    expect(body).toContain("| 2 | Second (`second`) | — | — | — |");
  });

  it("escapes pipes in a task title so the table cannot be broken", () => {
    const body = renderPlanBody({
      title: "T",
      slug: "s",
      proposalId: "p",
      tasks: [{ taskId: "x", title: "a | b" }],
    });
    expect(body).toContain("a \\| b (`x`)");
  });

  it("is deterministic — identical input renders identical bytes", () => {
    const input = {
      title: "T",
      slug: "s",
      proposalId: "p",
      tasks: [{ taskId: "x", title: "X", verify: "make" }],
    };
    expect(renderPlanBody(input)).toBe(renderPlanBody(input));
  });
});
