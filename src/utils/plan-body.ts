// ---------------------------------------------------------------------------
// plan-body — the body a promoted (source-linked) ARCS plan is born with
// ---------------------------------------------------------------------------
//
// Ported in shape from the donor cc-arcs `renderPromotedPlanBody`, minus the
// docs engine ARCS does not have: no pinned revisions, no `docRefs`, no
// sections. The plan stays EXECUTION-ONLY — the design lives in the accepted
// proposal doc — but a reader gets, without a second lookup: a pointer back to
// the accepted proposal, how to read it, and one row per task the proposal
// named.
//
// Pure and deterministic: no fs, no clock. The same input renders the same
// bytes, which is what keeps a re-promote repair-safe — a re-run writes what
// the first run would have.
// ---------------------------------------------------------------------------

export interface PlanBodyTask {
  /** Task id, shown beside the title so a reader can jump to `arcs task get`. */
  taskId: string;
  title: string;
  /** Workspace-relative `path[:anchor]` refs the task touches. */
  sourceFiles?: Array<{ path: string; anchor?: string }>;
  /** The task's verification command/check, rendered as inline code. */
  verify?: string;
}

export interface PlanBodyInput {
  /** Must equal the plan title so `buildBody` keeps this H1 as-is. */
  title: string;
  /** Optional summary paragraph echoed above the Source block. */
  summary?: string;
  /** Project slug, used only to render the retrieval hint. */
  slug: string;
  /** Accepted proposal doc id (the stem of `proposals/<id>.accepted.md`). */
  proposalId: string;
  /**
   * Task rows. When absent or empty the `## Tasks` section carries a
   * placeholder note instead of a table — ARCS has no breakdown parser, so
   * task creation stays a separate `writing-plans` step.
   */
  tasks?: PlanBodyTask[];
}

/** Escape the one character that would break a markdown table cell. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function fileRefCell(files: PlanBodyTask["sourceFiles"]): string {
  if (!files || files.length === 0) return "—";
  return files.map((f) => `\`${f.anchor ? `${f.path}:${f.anchor}` : f.path}\``).join(", ");
}

/**
 * Render the plan body. The H1 matches `title` exactly so `buildBody` (and the
 * `plan update-body` rewrite path) keeps it rather than prepending a second one.
 */
export function renderPlanBody(input: PlanBodyInput): string {
  const { title, summary, slug, proposalId, tasks } = input;
  const docPath = `proposals/${proposalId}.accepted.md`;

  const lines: string[] = [`# ${title}`, ""];
  if (summary) {
    lines.push(summary, "");
  }
  lines.push(
    "## Source",
    "",
    `- Proposal doc: \`${docPath}\` — \`arcs proposal-doc get ${slug} ${proposalId}\``,
    "",
    "This plan is execution-only. The design lives in the accepted proposal doc; the task list below is an index, not a substitute. Task creation is a separate `writing-plans` step.",
    "",
    "## Tasks",
    "",
  );

  if (tasks && tasks.length > 0) {
    lines.push(
      "| # | Task | Sections | Files | Verify |",
      "|---|------|----------|-------|--------|",
    );
    tasks.forEach((task, i) => {
      lines.push(
        `| ${i + 1} | ${cell(task.title)} (\`${task.taskId}\`) | — | ${fileRefCell(task.sourceFiles)} | ${task.verify ? `\`${cell(task.verify)}\`` : "—"} |`,
      );
    });
  } else {
    lines.push(
      "_No task list in the proposal. Create tasks with the `writing-plans` skill, then fill this body via `arcs plan update-body`._",
    );
  }

  lines.push("");
  return lines.join("\n");
}
