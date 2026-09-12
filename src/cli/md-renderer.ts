// md-renderer — Pure markdown renderer for CLI output in OpenCode chat panels

type Rec = Record<string, unknown>;

const STATUS_MARKER: Record<string, string> = {
  in_progress: "[/]",
  backlog: "[ ]",
  done: "[x]",
  cancelled: "[-]",
};

function marker(s: string): string {
  return STATUS_MARKER[s] ?? "[ ]";
}

const NULL_COMMANDS = new Set([
  "batch",
  "loop start",
  "loop cancel",
  "loop status",
  "lint-bundle",
  "deploy-superpowers",
  "git-log",
  "sync-agents-md",
  "dependency add",
  "dependency remove",
  "doc update",
  "paths update",
  "project init",
  "project update-doc",
  "project update-status",
  "project update-paths",
  "task delete",
  "plan delete",
  "plan update-body",
  "knowledge delete",
  "knowledge update-body",
  "diagram status",
  "diagram sort-metadata",
]);

// Group A — Single Entity

function formatTaskGet(d: Rec): string {
  const lines: string[] = [];
  lines.push(`**${d.title}**`);
  lines.push(`Status: ${d.status}  Priority: ${d.priority ?? "medium"}`);
  if (d.planId) lines.push(`Plan: ${d.planId}`);
  return lines.join("\n").trimEnd();
}

function formatTaskTransition(d: Rec): string {
  return `${d.taskId}: ${d.previousStatus} → ${d.newStatus}`;
}

function formatDone(d: Rec): string {
  const lines: string[] = [];
  const completed = (d.completed ?? {}) as Rec;
  lines.push(`✓ Done: ${completed.title ?? ""}`);
  lines.push("");

  const report = d.report as Rec | undefined;
  if (report) {
    const commit = typeof report.commit === "string" ? report.commit : "";
    const url = typeof report.url === "string" ? report.url : "";
    const short = commit !== "" ? commit.slice(0, 7) : "";
    const head = [short, url].filter((s) => s !== "").join(" ");
    lines.push(head === "" ? "Report: captured" : `Report: ${head}`);
    const files = typeof report.filesChanged === "number" ? report.filesChanged : 0;
    const ins = typeof report.insertions === "number" ? report.insertions : 0;
    const del = typeof report.deletions === "number" ? report.deletions : 0;
    const noun = files === 1 ? "file" : "files";
    const truncated = report.truncated === true ? " (diff truncated)" : "";
    // A snapshot over an uncommitted working tree is marked distinctly; a
    // clean receipt (or a legacy pointer without the flag) renders as before.
    const dirty = report.dirty === true ? " (uncommitted working tree)" : "";
    lines.push(`Diffstat: ${files} ${noun} changed, +${ins}/-${del}${truncated}${dirty}`);
  } else if (typeof d.reportSkipped === "string" && d.reportSkipped !== "") {
    lines.push(`Report: not captured (${d.reportSkipped})`);
  }

  const planReport = d.planReport as Rec | undefined;
  if (planReport) {
    const planCommit = typeof planReport.commit === "string" ? planReport.commit.slice(0, 7) : "";
    lines.push(`Plan report: ${planCommit === "" ? "captured" : planCommit}`);
  } else if (typeof d.planReportSkipped === "string" && d.planReportSkipped !== "") {
    lines.push(`Plan report: not captured (${d.planReportSkipped})`);
  }

  const next = d.next as Rec | null | undefined;
  if (next) {
    lines.push(`Next: ${next.title}`);
    if (next.plan) lines.push(`Plan: ${next.plan}`);
    lines.push("");
    lines.push(`Run: arcs done ${d.slug} ${next.id}`);
  } else {
    lines.push("All tasks complete! Nothing left to do.");
  }

  const learned = d.learned as Rec | undefined;
  if (learned) {
    lines.push(`✓ Remembered [${learned.kind}]: ${learned.title}`);
  }

  return lines.join("\n").trimEnd();
}

function formatReportGet(d: Rec): string {
  const receipt = (d.receipt ?? {}) as Rec;
  const lines: string[] = [];
  lines.push(`## Receipt: ${d.taskId ?? d.planId ?? "unknown"}`);
  lines.push("");
  if (receipt.headSha) lines.push(`Commit: ${receipt.headSha}`);
  if (receipt.baseSha) lines.push(`Base: ${receipt.baseSha}`);
  if (receipt.branch) lines.push(`Branch: ${receipt.branch}`);
  if (receipt.url) lines.push(`Link: ${receipt.url}`);
  const files = typeof receipt.filesChanged === "number" ? receipt.filesChanged : 0;
  const noun = files === 1 ? "file" : "files";
  const truncated = receipt.truncated === true ? " (diff truncated)" : "";
  const dirty = receipt.dirty === true ? " (uncommitted working tree)" : "";
  lines.push(
    `Diffstat: ${files} ${noun} changed, +${receipt.insertions ?? 0}/-${receipt.deletions ?? 0}${truncated}${dirty}`,
  );
  if (receipt.capturedAt) lines.push(`Captured: ${receipt.capturedAt}`);
  if (typeof d.diff === "string") {
    lines.push("");
    lines.push("```diff");
    lines.push(d.diff);
    lines.push("```");
  }
  return lines.join("\n").trimEnd();
}

function formatReportList(d: unknown): string {
  const items = Array.isArray(d) ? d : ((d as Rec).receipts ?? []);
  const arr = items as Rec[];
  const lines: string[] = [`## Receipts (${arr.length})`, ""];
  for (const r of arr) {
    const id = r.id ?? r.taskId ?? r.planId ?? "?";
    const short = typeof r.headSha === "string" ? r.headSha.slice(0, 7) : "";
    const noun = r.filesChanged === 1 ? "file" : "files";
    lines.push(
      `- ${id} ${short} — ${r.filesChanged ?? 0} ${noun} changed, +${r.insertions ?? 0}/-${r.deletions ?? 0}`,
    );
  }
  return lines.join("\n").trimEnd();
}

function shortSha(value: unknown): string {
  return typeof value === "string" && value !== "" ? value.slice(0, 7) : "";
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/**
 * Append a plan completion-receipt block (link + range + diffstat + per-task
 * attribution) to a `plan get` rendering. No-op when the plan has no receipt,
 * so the pre-receipt output is unchanged.
 */
function appendPlanReceipt(lines: string[], d: Rec): void {
  const pointer = d.report as Rec | undefined;
  const receipt = d.receipt as Rec | undefined;
  if (!pointer && !receipt) return;

  const url =
    typeof receipt?.url === "string" && receipt.url !== ""
      ? receipt.url
      : typeof pointer?.url === "string"
        ? pointer.url
        : "";
  const base = receipt?.baseSha ?? pointer?.baseRef;
  const head = receipt?.headSha ?? pointer?.commit;
  const files = num(receipt?.filesChanged ?? pointer?.filesChanged);
  const ins = num(receipt?.insertions ?? pointer?.insertions);
  const del = num(receipt?.deletions ?? pointer?.deletions);
  const truncated = (receipt?.truncated ?? pointer?.truncated) === true ? " (diff truncated)" : "";
  const noun = files === 1 ? "file" : "files";

  lines.push("");
  if (url !== "") lines.push(`Commit: ${url}`);
  if (shortSha(base) !== "" && shortSha(head) !== "") {
    lines.push(`Range: ${shortSha(base)} → ${shortSha(head)}`);
  }
  lines.push(`Diffstat: ${files} ${noun} changed, +${ins}/-${del}${truncated}`);

  const attribution = receipt?.taskAttribution;
  if (Array.isArray(attribution) && attribution.length > 0) {
    lines.push("");
    lines.push("Tasks:");
    for (const raw of attribution as Rec[]) {
      const id = String(raw.taskId ?? "?");
      const range = [shortSha(raw.startHead), shortSha(raw.commit)]
        .filter((s) => s !== "")
        .join(" → ");
      const f = num(raw.filesChanged);
      const suffix = [
        range,
        `${f} ${f === 1 ? "file" : "files"} changed, +${num(raw.insertions)}/-${num(raw.deletions)}`,
      ]
        .filter((s) => s !== "")
        .join(" — ");
      lines.push(`- ${id}${suffix !== "" ? `: ${suffix}` : ""}`);
    }
  }

  if (typeof d.diff === "string" && d.diff !== "") {
    lines.push("");
    lines.push("```diff");
    lines.push(d.diff);
    lines.push("```");
  }
}

function formatPlanGet(d: Rec): string {
  if (d.body) return formatPlanBody(d);
  const lines: string[] = [];
  lines.push(`**${d.title}**`);
  lines.push(`Status: ${d.status}`);
  if (d.summary) {
    lines.push("");
    lines.push(String(d.summary));
  }
  if (Array.isArray(d.keywords) && d.keywords.length > 0) {
    lines.push("");
    lines.push(`Tags: ${(d.keywords as string[]).join(", ")}`);
  }
  appendPlanReceipt(lines, d);
  return lines.join("\n").trimEnd();
}

function formatPlanBody(d: Rec): string {
  const lines: string[] = [];
  lines.push(`**${d.title}**`);
  lines.push(`Status: ${d.status}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(String(d.body));
  appendPlanReceipt(lines, d);
  return lines.join("\n").trimEnd();
}

/**
 * Append each captured code chunk as a fenced block headed by its
 * `path:start-end` range. The fence info string uses the chunk's stored
 * `language` when present and falls back to a plain fence otherwise. No-op
 * for entries without chunks, so the pre-chunk rendering is unchanged.
 * Staleness is deliberately not evaluated here: the renderer stays pure and
 * never reads the filesystem.
 */
function appendKnowledgeCodeChunks(lines: string[], rec: Rec): void {
  const chunks = rec.codeChunks;
  if (!Array.isArray(chunks) || chunks.length === 0) return;
  for (const raw of chunks as Rec[]) {
    const path = typeof raw.path === "string" ? raw.path : "";
    const language = typeof raw.language === "string" && raw.language !== "" ? raw.language : "";
    lines.push("");
    lines.push(`${path}:${raw.startLine}-${raw.endLine}`);
    lines.push(`\`\`\`${language}`);
    lines.push(String(raw.snippet ?? ""));
    lines.push("```");
  }
}

function formatKnowledgeGet(d: Rec): string {
  const rec = (d.meta ? d.meta : d) as Rec;
  if (d.body) return formatKnowledgeBody(d);
  const lines: string[] = [];
  lines.push(`**${rec.title}** (${rec.kind})`);
  if (rec.summary) {
    lines.push("");
    lines.push(String(rec.summary));
  }
  if (Array.isArray(rec.keywords) && rec.keywords.length > 0) {
    lines.push("");
    lines.push(`Tags: ${(rec.keywords as string[]).join(", ")}`);
  }
  appendKnowledgeCodeChunks(lines, rec);
  return lines.join("\n").trimEnd();
}

function formatKnowledgeTemplate(d: Rec): string {
  return String(d.markdown ?? "").trimEnd();
}

function formatKnowledgeBody(d: Rec): string {
  const rec = (d.meta ? d.meta : d) as Rec;
  const lines: string[] = [];
  lines.push(`**${rec.title}** (${rec.kind})`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(String(d.body));
  appendKnowledgeCodeChunks(lines, rec);
  return lines.join("\n").trimEnd();
}

// Group B — Lists

function formatTaskList(d: unknown): string {
  const items = Array.isArray(d) ? d : ((d as Rec).tasks ?? []);
  const arr = items as Rec[];
  const lines: string[] = [];
  lines.push(`## Tasks (${arr.length})`);
  lines.push("");
  const order = ["in_progress", "backlog", "done", "cancelled"];
  const grouped = new Map<string, Rec[]>();
  for (const t of arr) {
    const s = String(t.status);
    if (!grouped.has(s)) grouped.set(s, []);
    grouped.get(s)!.push(t);
  }
  for (const status of order) {
    const group = grouped.get(status);
    if (!group || group.length === 0) continue;
    for (const t of group) {
      lines.push(`- ${marker(String(t.status))} ${t.title}  [${t.priority ?? "medium"}]`);
    }
  }
  return lines.join("\n").trimEnd();
}

function formatPlanList(d: unknown): string {
  const items = Array.isArray(d) ? d : ((d as Rec).plans ?? []);
  const arr = items as Rec[];
  const lines: string[] = [];
  lines.push(`## Plans (${arr.length})`);
  lines.push("");
  for (const p of arr) {
    lines.push(`- ${p.title} [${p.status}]`);
  }
  return lines.join("\n").trimEnd();
}

function formatKnowledgeList(d: unknown): string {
  const items = Array.isArray(d) ? d : ((d as Rec).entries ?? []);
  const arr = items as Rec[];
  const lines: string[] = [];
  lines.push(`## Knowledge (${arr.length})`);
  lines.push("");
  for (const k of arr) {
    lines.push(`- ${k.title} (${k.kind})`);
  }
  return lines.join("\n").trimEnd();
}

function formatProjectList(d: unknown): string {
  const items = Array.isArray(d) ? d : ((d as Rec).projects ?? []);
  const arr = items as Rec[];
  const lines: string[] = [];
  lines.push(`## Projects (${arr.length})`);
  lines.push("");
  for (const p of arr) {
    const desc = p.description ? ` — ${p.description}` : "";
    lines.push(`- **${p.name}** [${p.status}]${desc}`);
  }
  return lines.join("\n").trimEnd();
}

// Group C — Body / Passthrough

function formatPassthrough(d: Rec): string {
  return String(d.content ?? d.output ?? "").trimEnd();
}

function formatProjectGet(d: Rec): string {
  if (d.content) return String(d.content).trimEnd();
  const lines: string[] = [];
  lines.push(`# ${d.name}`);
  if (d.description) {
    lines.push("");
    lines.push(String(d.description));
  }
  if (d.status) {
    lines.push("");
    lines.push(`Status: ${d.status}`);
  }
  return lines.join("\n").trimEnd();
}

// Group D — Search

function formatSearch(d: unknown): string {
  const items = Array.isArray(d) ? d : ((d as Rec).results ?? []);
  const arr = items as Rec[];
  const lines: string[] = [];
  for (let i = 0; i < arr.length; i++) {
    const r = arr[i];
    const score = typeof r.score === "number" ? (r.score as number).toFixed(2) : "0.00";
    lines.push(`${i + 1}. **${r.title}** (${r.type}) — score: ${score}`);
  }
  return lines.join("\n").trimEnd();
}

function formatRelated(d: unknown): string {
  const items = Array.isArray(d) ? d : ((d as Rec).related ?? []);
  const arr = items as Rec[];
  const lines: string[] = [];
  lines.push(`## Related (${arr.length})`);
  lines.push("");
  for (const r of arr) {
    lines.push(`- ${r.title} [${r.type}] via ${r.via}`);
  }
  return lines.join("\n").trimEnd();
}

function formatGraphInspect(d: Rec): string {
  const lines: string[] = [];
  lines.push(`- Nodes: ${d.nodes ?? d.nodeCount ?? 0}`);
  lines.push(`- Edges: ${d.edges ?? d.edgeCount ?? 0}`);
  if (d.density !== undefined) lines.push(`- Density: ${d.density}`);
  return lines.join("\n").trimEnd();
}

// Group E — Validation / Status

function formatValidate(d: Rec): string {
  const issues = (d.issues ?? []) as Rec[];
  const total = (d.totalChecks ?? d.checksRun ?? 0) as number;
  if (issues.length === 0) {
    return `No issues found (${total} checks passed).`;
  }
  const lines: string[] = [];
  lines.push(`${issues.length} issues found`);
  lines.push("");
  for (const issue of issues) {
    const hint = issue.repair ? ` (${issue.repair})` : "";
    lines.push(`- [${issue.severity}] ${issue.message}${hint}`);
  }
  return lines.join("\n").trimEnd();
}

function formatDiff(d: Rec): string {
  const lines: string[] = [];
  lines.push(`## Changes since ${d.since ?? "unknown"}`);
  lines.push("");
  const sections = ["plans", "knowledge", "tasks"] as const;
  for (const section of sections) {
    const items = d[section] as Rec | undefined;
    if (!items) continue;
    const label = section.charAt(0).toUpperCase() + section.slice(1);
    const count = (items.added ?? 0) as number;
    const modified = (items.modified ?? 0) as number;
    lines.push(`**${label}**: ${count} added, ${modified} modified`);
  }
  return lines.join("\n").trimEnd();
}

function formatDiagramReady(d: unknown): string {
  // New envelope: { ready, blocked, inProgress, done } — render all four buckets.
  // Legacy fallbacks (bare list, { nodes }) preserved for forward compat with
  // any cached/streaming consumer.
  const lines: string[] = [];
  const renderBucket = (label: string, items: unknown): void => {
    const arr = Array.isArray(items) ? items : [];
    lines.push(`### ${label} (${arr.length})`);
    if (arr.length === 0) {
      lines.push("- _none_");
    } else {
      for (const node of arr) {
        const id = typeof node === "string" ? node : ((node as Rec).id ?? (node as Rec).nodeId);
        lines.push(`- ${id}`);
      }
    }
    lines.push("");
  };

  if (Array.isArray(d)) {
    lines.push("## Ready Nodes");
    lines.push("");
    for (const node of d) {
      const id = typeof node === "string" ? node : ((node as Rec).id ?? (node as Rec).nodeId);
      lines.push(`- ${id}`);
    }
    return lines.join("\n").trimEnd();
  }

  const rec = (d ?? {}) as Rec;
  if (Array.isArray(rec.nodes)) {
    lines.push("## Ready Nodes");
    lines.push("");
    for (const node of rec.nodes as (string | Rec)[]) {
      const id = typeof node === "string" ? node : ((node as Rec).id ?? (node as Rec).nodeId);
      lines.push(`- ${id}`);
    }
    return lines.join("\n").trimEnd();
  }

  lines.push("## Diagram Status");
  lines.push("");
  renderBucket("Ready", rec.ready);
  renderBucket("In Progress", rec.inProgress);
  renderBucket("Blocked", rec.blocked);
  renderBucket("Done", rec.done);
  return lines.join("\n").trimEnd();
}

function formatDiagramValidate(d: Rec): string {
  const errors = (d.errors ?? []) as Rec[];
  if (errors.length === 0) return "Valid.";
  const lines: string[] = [];
  lines.push(`${errors.length} errors:`);
  lines.push("");
  for (const e of errors) {
    lines.push(`- ${e.message ?? e}`);
  }
  return lines.join("\n").trimEnd();
}

function formatDiagramInspect(d: Rec): string {
  const lines: string[] = [];
  for (const [key, val] of Object.entries(d)) {
    if (Array.isArray(val)) {
      lines.push(`- ${key}: ${val.length} items`);
    } else if (typeof val === "object" && val !== null) {
      lines.push(`- ${key}: ${JSON.stringify(val)}`);
    } else {
      lines.push(`- ${key}: ${val}`);
    }
  }
  return lines.join("\n").trimEnd();
}

// Group F — Context

function formatContext(d: Rec): string {
  const lines: string[] = [];
  lines.push(`# ${d.name ?? d.slug}`);
  lines.push("");
  if (d.operatingBrief) {
    const ob = d.operatingBrief as Rec;
    lines.push(`**Current Focus:** ${ob.currentFocus ?? ""}`);
    lines.push(`**Surface:** ${ob.recommendedSurface ?? ""}`);
    if (ob.why) lines.push(`**Why:** ${ob.why}`);
    if (ob.nextAction) lines.push(`**Next:** ${ob.nextAction}`);
    lines.push("");
  }
  if (Array.isArray(d.tasks) && d.tasks.length > 0) {
    lines.push("## Tasks");
    lines.push("");
    for (const t of d.tasks as Rec[]) {
      lines.push(`- ${marker(String(t.status))} ${t.title}`);
    }
    lines.push("");
  }
  if (Array.isArray(d.plans) && d.plans.length > 0) {
    lines.push("## Plans");
    lines.push("");
    for (const p of d.plans as Rec[]) {
      lines.push(`- ${p.title} [${p.status}]`);
    }
    lines.push("");
  }
  if (Array.isArray(d.knowledge) && d.knowledge.length > 0) {
    lines.push("## Knowledge");
    lines.push("");
    for (const k of d.knowledge as Rec[]) {
      lines.push(`- ${k.title} (${k.kind})`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

// Router

/**
 * Renders structured CLI data as plain markdown for OpenCode chat panels.
 * Returns null for commands that don't benefit from markdown formatting.
 */
export function renderMarkdown(command: string, data: unknown): string | null {
  if (NULL_COMMANDS.has(command)) return null;
  if (data === null || data === undefined) return null;
  if (typeof data === "string") return null;

  const d = data as Rec;

  switch (command) {
    // Group A
    case "task get":
    case "task create":
    case "task update":
      return formatTaskGet(d);
    case "task transition":
      return formatTaskTransition(d);
    case "done":
      return formatDone(d);
    case "report get":
      return formatReportGet(d);
    case "report list":
      return formatReportList(d);
    case "plan get":
      return formatPlanGet(d);
    case "plan create":
    case "plan update-meta":
      return formatPlanGet(d);
    case "knowledge get":
      return formatKnowledgeGet(d);
    case "knowledge create":
    case "knowledge update-meta":
      return formatKnowledgeGet(d);
    case "knowledge template":
      return formatKnowledgeTemplate(d);

    // Group B
    case "task list":
      return formatTaskList(d);
    case "plan list":
      return formatPlanList(d);
    case "knowledge list":
      return formatKnowledgeList(d);
    case "project list":
      return formatProjectList(d);

    // Group C
    case "project get":
      return formatProjectGet(d);
    case "agents-md":
    case "diagram show":
      return formatPassthrough(d);

    // Group D
    case "search":
    case "knowledge search":
      return formatSearch(d);
    case "related":
      return formatRelated(d);
    case "graph inspect":
      return formatGraphInspect(d);

    // Group E
    case "validate":
    case "project validate":
      return formatValidate(d);
    case "audit":
      return formatValidate(d);
    case "diff":
      return formatDiff(d);
    case "diagram ready":
      return formatDiagramReady(d);
    case "diagram validate":
      return formatDiagramValidate(d);
    case "diagram inspect":
      return formatDiagramInspect(d);

    // Group F
    case "context":
      return formatContext(d);

    default:
      return null;
  }
}
