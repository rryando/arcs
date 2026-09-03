/**
 * ARCS sidebar for pi — Atelier panel + web status + TUI modal reader.
 *
 * Consolidates the two repo-owned pi extensions (the Atelier overview panel
 * and the web-status footer entry) and adds an interactive in-terminal modal
 * reader, because Atelier sidebar rows are not clickable.
 *
 * - Publishes a live "ARCS" panel to the Atelier sidebar
 *   (npm:pi-atelier) via the `pi-atelier:sidebar-panels` protocol (v1).
 * - Polls `GET /api/health` and keeps an `arcs-web` footer entry
 *   (kept with the ○ down glyph when unreachable, never cleared).
 * - `/arcs-open [target]` renders plan/proposal/task/brief content in a
 *   keyboard driven TUI overlay modal (j/k scroll, q/Esc close). This is
 *   the interactive reader — Atelier rows stay display-only.
 * - `/arcs-web` opens the web UI in the detached browser, scoped to the
 *   current project (`/p/<slug>`) when resolvable, else the base URL.
 * - `/arcs-refresh` refreshes the Atelier panel + footer immediately.
 *
 * All content is read through the `arcs` CLI (`ARCS_BIN` env override) with
 * the session cwd — no daemon, no token handling.
 *
 * Install via `arcs init` (pi deploy step) or manually:
 *   cp web/extensions/arcs-sidebar.ts ~/.pi/agent/extensions/
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const ATELIER_CHANNEL = "pi-atelier:sidebar-panels";
const ATELIER_PROTOCOL_VERSION = 1;
const ATELIER_SOURCE = "arcs";
const ATELIER_PANEL_ID = "arcs:overview";
const MAX_ROWS = 24;
const ARCS_BIN = process.env.ARCS_BIN ?? "arcs";
const REFRESH_INTERVAL_MS = 12_000;

const DEFAULT_WEB_PORT = 8745;
const WEB_CONFIG_FILE = "web-config.json";
const WEB_STATUS_KEY = "arcs-web";
const WEB_POLL_INTERVAL_MS = 5_000;
const FETCH_TIMEOUT_MS = 3_000;

type RowRole =
  | "primary"
  | "accent"
  | "muted"
  | "dim"
  | "ready"
  | "working"
  | "warning"
  | "error"
  | "input"
  | "output"
  | "cache"
  | "context";

type Row = string | { text: string; role?: RowRole };

// Minimal structural types for the TUI overlay — kept local so this file
// needs nothing beyond the pi extension types at load time.
type ModalTheme = { fg: (style: string, text: string) => string };
type ModalDone = () => void;
interface ModalComponent {
  render: (width: number) => string[];
  handleInput?: (data: string) => void;
  invalidate: () => void;
}

// ---------------------------------------------------------------------------
// arcs CLI payloads (subset of what arcs emits with --json --lean)
// ---------------------------------------------------------------------------

type BriefData = {
  slug: string;
  name: string;
  operatingBrief: {
    currentFocus: string;
    recommendedSurface: string;
    why: string;
    nextAction: string;
  };
  openTasksCount: number;
  knowledgeHealth: { total: number; thin: number; stale: number };
  topKnowledge?: Array<{ kind: string; title: string }>;
};

type StatusData = {
  project: string;
  plans: { active: number; done: number; archived: number };
  tasks: { open: number; done: number };
  knowledge: { total: number; byKind?: Record<string, number> };
};

type NextData = {
  task?: { id: string; title: string; status: string; priority?: string };
  context?: string;
};

type PlanSummary = { id: string; title: string; status: string };
type DiagramReady = { ready: string[]; blocked: string[]; inProgress: string[]; done: string[] };
type DiagramInspect = { nodes: Array<{ id: string; label: string; status: string }> };

// ---------------------------------------------------------------------------
// arcs CLI + web helpers
// ---------------------------------------------------------------------------

function execArcs(
  args: string[],
  cwd: string,
  timeoutMs = 6000,
): Promise<{ ok: boolean; json?: unknown; raw: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(ARCS_BIN, args, { cwd, shell: false, timeout: timeoutMs });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => {
      out += d.toString();
    });
    child.stderr?.on("data", (d) => {
      err += d.toString();
    });
    child.on("error", () => resolvePromise({ ok: false, raw: err || "spawn failed" }));
    child.on("close", (code) => {
      const raw = out || err;
      if (code !== 0 && !out) return resolvePromise({ ok: false, raw: raw.slice(0, 800) });
      try {
        const parsed = JSON.parse(out);
        resolvePromise({ ok: parsed.ok !== false, json: parsed.data ?? parsed, raw: out });
      } catch {
        resolvePromise({ ok: false, raw: raw.slice(0, 800) });
      }
    });
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already exited */
      }
    }, timeoutMs + 500);
  });
}

async function resolveSlug(cwd: string): Promise<string | undefined> {
  const res = await execArcs(["brief", cwd, "--json", "--lean"], cwd);
  if (!res.ok) return undefined;
  const slug = (res.json as { slug?: unknown } | undefined)?.slug;
  return typeof slug === "string" && slug ? slug : undefined;
}

function truncate(s: unknown, n: number): string {
  const str = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (str.length <= n) return str;
  return `${str.slice(0, Math.max(0, n - 1))}…`;
}

/** ARCS data dir: ARCS_DATA_DIR env var wins, else ~/.arcs (mirrors getDataDir()). */
function arcsDataDir(): string {
  const envDir = process.env.ARCS_DATA_DIR;
  if (envDir) return resolve(envDir);
  return join(homedir(), ".arcs");
}

/**
 * Read the persisted web port. Absent/unreadable/invalid config falls back to
 * the default — same validation the server applies in persistedWebPort().
 */
function resolveWebPort(): number {
  try {
    const raw = JSON.parse(readFileSync(join(arcsDataDir(), WEB_CONFIG_FILE), "utf-8")) as {
      port?: unknown;
    };
    const port = raw.port;
    return typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535
      ? port
      : DEFAULT_WEB_PORT;
  } catch {
    return DEFAULT_WEB_PORT;
  }
}

/** True when the health endpoint answers with a 2xx AND an ok envelope. */
async function isWebServerUp(url: string): Promise<boolean> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return false;
  const body = (await res.json()) as { ok?: unknown };
  return body.ok === true;
}

/** Open a URL in the platform default browser, detached from pi. */
function openBrowser(url: string): void {
  let command: string;
  let args: string[];
  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

// ---------------------------------------------------------------------------
// Atelier snapshot
// ---------------------------------------------------------------------------

interface Snapshot {
  title: string;
  rows: Row[];
}

async function planDiagramCounts(
  slug: string,
  planId: string,
  cwd: string,
): Promise<{ ready: DiagramReady; nodes: DiagramInspect["nodes"] } | undefined> {
  const [readyRes, inspectRes] = await Promise.all([
    execArcs(["diagram", "ready", slug, planId, "--json", "--lean"], cwd),
    execArcs(["diagram", "inspect", slug, planId, "--json", "--lean"], cwd),
  ]);
  if (!readyRes.ok && !inspectRes.ok) return undefined;
  const readyPayload =
    readyRes.ok && readyRes.json && typeof readyRes.json === "object"
      ? (readyRes.json as Partial<DiagramReady>)
      : {};
  const ready: DiagramReady = {
    ready: Array.isArray(readyPayload.ready) ? readyPayload.ready : [],
    blocked: Array.isArray(readyPayload.blocked) ? readyPayload.blocked : [],
    inProgress: Array.isArray(readyPayload.inProgress) ? readyPayload.inProgress : [],
    done: Array.isArray(readyPayload.done) ? readyPayload.done : [],
  };
  const inspectPayload =
    inspectRes.ok && inspectRes.json && typeof inspectRes.json === "object"
      ? (inspectRes.json as Partial<DiagramInspect>)
      : {};
  const nodes = Array.isArray(inspectPayload.nodes) ? inspectPayload.nodes : [];
  return { ready, nodes };
}

async function buildSnapshot(cwd: string, error?: string): Promise<Snapshot> {
  const briefRes = await execArcs(["brief", cwd, "--json", "--lean"], cwd);
  if (!briefRes.ok) {
    return {
      title: "ARCS",
      rows: [
        { text: "ARCS", role: "accent" },
        { text: truncate(briefRes.raw || "no ARCS project", 140), role: "warning" },
        { text: "run: arcs project new / arcs brief · /arcs-open needs a project", role: "dim" },
      ],
    };
  }
  const brief = briefRes.json as BriefData;
  if (!brief?.slug) {
    return { title: "ARCS", rows: [{ text: "No ARCS project", role: "warning" }] };
  }
  const slug = brief.slug;
  const ob = brief.operatingBrief ?? ({} as BriefData["operatingBrief"]);
  const surface = String(ob.recommendedSurface ?? "PLAN");

  const [statusRes, nextRes, planListRes, proposalListRes] = await Promise.all([
    execArcs(["status", slug, "--json", "--lean"], cwd),
    execArcs(["next", slug, "--json", "--lean"], cwd),
    execArcs(["plan", "list", slug, "--json", "--lean"], cwd),
    execArcs(["proposal-doc", "list", slug, "--json", "--lean"], cwd),
  ]);

  const status = statusRes.ok ? (statusRes.json as StatusData) : undefined;
  const next =
    nextRes.ok && (nextRes.json as NextData | undefined)?.task
      ? (nextRes.json as NextData)
      : undefined;

  const plansRaw = planListRes.json;
  const planList: PlanSummary[] = Array.isArray(plansRaw)
    ? (plansRaw as PlanSummary[])
    : Array.isArray((plansRaw as { plans?: PlanSummary[] } | undefined)?.plans)
      ? (plansRaw as { plans: PlanSummary[] }).plans
      : [];
  const activePlans = planList
    .filter((p) => p.status !== "done" && p.status !== "archived")
    .slice(0, 2);

  const proposalRaw = proposalListRes.ok ? proposalListRes.json : undefined;
  const proposals: Array<{ id: string }> = Array.isArray(proposalRaw)
    ? (proposalRaw as Array<{ id: string }>)
    : Array.isArray((proposalRaw as { proposals?: unknown } | undefined)?.proposals)
      ? (proposalRaw as { proposals: Array<{ id: string }> }).proposals
      : [];

  const kh = brief.knowledgeHealth ?? { total: 0, thin: 0, stale: 0 };
  const rows: Row[] = [];

  rows.push({ text: truncate(brief.name || slug, 40), role: "primary" });
  rows.push({ text: `● ${surface}`, role: "accent" });
  if (ob.currentFocus) rows.push({ text: `  ${truncate(ob.currentFocus, 120)}`, role: "ready" });
  if (ob.why) rows.push({ text: `  ${truncate(ob.why, 120)}`, role: "muted" });
  if (ob.nextAction) rows.push({ text: `  → ${truncate(ob.nextAction, 120)}`, role: "context" });

  if (status) {
    rows.push({
      text: `plans ${status.plans.active} active · ${status.plans.done} done`,
      role: "dim",
    });
    rows.push({
      text: `tasks ${status.tasks.open} open · KB ${kh.total}${kh.thin ? ` (${kh.thin} thin)` : ""}`,
      role: "dim",
    });
  } else {
    rows.push({ text: `KB ${kh.total}${kh.thin ? ` (${kh.thin} thin)` : ""}`, role: "dim" });
  }

  if (next?.task) {
    rows.push({ text: `▶ ${truncate(next.task.id, 40)}`, role: "accent" });
    rows.push({ text: `  ${truncate(next.task.title, 110)}`, role: "primary" });
    if (next.task.priority) rows.push({ text: `  [${next.task.priority}]`, role: "muted" });
  }

  if (activePlans.length === 0) {
    rows.push({ text: "no active plans", role: "dim" });
  } else {
    for (const [index, plan] of activePlans.entries()) {
      const diagram = await planDiagramCounts(slug, plan.id, cwd);
      rows.push({ text: `◈ ${truncate(plan.title || plan.id, 44)}`, role: "accent" });
      if (diagram) {
        const counts = `●${diagram.ready.done.length} ○${diagram.ready.ready.length} ◌${diagram.ready.blocked.length}`;
        rows.push({ text: `  ${counts} · /arcs-open plan ${plan.id}`, role: "muted" });
        if (index === 0) {
          for (const node of diagram.nodes.slice(0, 3)) {
            const mark =
              node.status === "done" ? "[v]" : node.status === "in_progress" ? "[·]" : "[ ]";
            const role: RowRole =
              node.status === "done" ? "ready" : node.status === "blocked" ? "warning" : "dim";
            rows.push({ text: `  ${mark} ${truncate(node.label, 100)}`, role });
          }
        }
      } else {
        rows.push({ text: "  (no diagram)", role: "muted" });
      }
    }
  }

  if (brief.topKnowledge?.length) {
    for (const k of brief.topKnowledge.slice(0, 3)) {
      rows.push({ text: `◆ ${truncate(k.kind, 14)} ${truncate(k.title, 80)}`, role: "muted" });
    }
  }

  if (proposals.length > 0) {
    const first = proposals[0]?.id ?? "";
    rows.push({
      text: `⧉ proposals ${proposals.length} pending${first ? ` · /arcs-open proposal ${first}` : ""}`,
      role: "warning",
    });
  }

  rows.push({ text: "/arcs-open plan|proposal|task|next|status · /arcs-web", role: "dim" });
  if (error) rows.push({ text: truncate(error, 140), role: "error" });

  return { title: truncate(brief.name || "ARCS", 44), rows: rows.slice(0, MAX_ROWS) };
}

// ---------------------------------------------------------------------------
// Reader content builders (plain text for the modal)
// ---------------------------------------------------------------------------

function section(title: string, lines: string[]): string[] {
  return [title, ...lines.map((l) => (l ? `  ${l}` : "")), ""];
}

async function readBriefLines(cwd: string): Promise<{ title: string; lines: string[] }> {
  const res = await execArcs(["brief", cwd, "--json", "--lean"], cwd);
  if (!res.ok)
    return { title: "ARCS brief", lines: ["No ARCS project here.", truncate(res.raw, 200)] };
  const b = res.json as BriefData;
  const ob = b.operatingBrief ?? ({} as BriefData["operatingBrief"]);
  const kh = b.knowledgeHealth ?? { total: 0, thin: 0, stale: 0 };
  return {
    title: `ARCS brief — ${b.name || b.slug}`,
    lines: [
      ...section("Phase", [`● ${ob.recommendedSurface ?? "?"}`]),
      ...section("Focus", [String(ob.currentFocus ?? "—")]),
      ...section("Why", [String(ob.why ?? "—")]),
      ...section("Next action", [String(ob.nextAction ?? "—")]),
      ...section("Health", [
        `open tasks: ${b.openTasksCount ?? "?"}`,
        `knowledge: ${kh.total} total${kh.thin ? `, ${kh.thin} thin` : ""}${kh.stale ? `, ${kh.stale} stale` : ""}`,
      ]),
      ...(b.topKnowledge?.length
        ? section(
            "Top knowledge",
            b.topKnowledge.slice(0, 5).map((k) => `◆ [${k.kind}] ${k.title}`),
          )
        : []),
    ],
  };
}

async function readStatusLines(cwd: string): Promise<{ title: string; lines: string[] }> {
  const slug = await resolveSlug(cwd);
  if (!slug) return { title: "ARCS status", lines: ["No ARCS project here."] };
  const res = await execArcs(["status", slug, "--json", "--lean"], cwd);
  if (!res.ok) return { title: "ARCS status", lines: [truncate(res.raw, 300)] };
  const s = res.json as StatusData;
  return {
    title: `ARCS status — ${s.project || slug}`,
    lines: [
      ...section("Plans", [
        `active: ${s.plans.active}, done: ${s.plans.done}, archived: ${s.plans.archived}`,
      ]),
      ...section("Tasks", [`open: ${s.tasks.open}, done: ${s.tasks.done}`]),
      ...section("Knowledge", [
        `total: ${s.knowledge.total}`,
        ...(s.knowledge.byKind
          ? Object.entries(s.knowledge.byKind).map(([k, v]) => `${k}: ${v}`)
          : []),
      ]),
    ],
  };
}

async function readNextLines(cwd: string): Promise<{ title: string; lines: string[] }> {
  const slug = await resolveSlug(cwd);
  if (!slug) return { title: "ARCS next", lines: ["No ARCS project here."] };
  const res = await execArcs(["next", slug, "--json", "--lean"], cwd);
  if (!res.ok) return { title: "ARCS next", lines: [truncate(res.raw, 300)] };
  const n = res.json as NextData;
  if (!n?.task) return { title: "ARCS next", lines: ["Queue is empty — nothing ready."] };
  return {
    title: `ARCS next — ${n.task.id}`,
    lines: [
      ...section("Task", [
        `${n.task.title}`,
        `id: ${n.task.id} · status: ${n.task.status}${n.task.priority ? ` · priority: ${n.task.priority}` : ""}`,
      ]),
      ...(n.context ? section("Context", [n.context]) : []),
      ...section("Open it", [`/arcs-open task ${n.task.id}`]),
    ],
  };
}

async function readPlanLines(
  cwd: string,
  planId: string,
): Promise<{ title: string; lines: string[] }> {
  const slug = await resolveSlug(cwd);
  if (!slug) return { title: "ARCS plan", lines: ["No ARCS project here."] };
  const res = await execArcs(["plan", "get", slug, planId, "--body", "--json", "--lean"], cwd);
  if (!res.ok) return { title: "ARCS plan", lines: [truncate(res.raw, 300)] };
  const payload = res.json as {
    meta?: { id: string; title: string; status: string; summary?: string };
    id?: string;
    title?: string;
    status?: string;
    summary?: string;
    body?: string;
  };
  const meta = payload.meta ?? payload;
  const lines = [
    ...section("Plan", [
      `${meta.title || planId}`,
      `id: ${meta.id || planId} · status: ${meta.status || "?"}`,
    ]),
    ...(meta.summary ? section("Summary", [meta.summary]) : []),
  ];
  if (typeof payload.body === "string" && payload.body) {
    lines.push("Body", ...payload.body.split("\n"), "");
  } else {
    lines.push("(no body — plan has metadata only)", "");
  }
  return { title: `ARCS plan — ${meta.title || planId}`, lines };
}

async function readTaskLines(
  cwd: string,
  taskId: string,
): Promise<{ title: string; lines: string[] }> {
  const slug = await resolveSlug(cwd);
  if (!slug) return { title: "ARCS task", lines: ["No ARCS project here."] };
  const res = await execArcs(["task", "get", slug, taskId, "--json", "--lean"], cwd);
  if (!res.ok) return { title: "ARCS task", lines: [truncate(res.raw, 300)] };
  const t = res.json as Record<string, unknown>;
  const pick = (k: string): string => {
    const v = t[k];
    return typeof v === "string" || typeof v === "number" ? String(v) : "";
  };
  const lines = section("Task", [
    `${pick("title") || taskId}`,
    `id: ${pick("id") || taskId}${pick("status") ? ` · status: ${pick("status")}` : ""}${pick("priority") ? ` · priority: ${pick("priority")}` : ""}${pick("planId") ? ` · plan: ${pick("planId")}` : ""}`,
  ]);
  for (const k of ["description", "context", "notes"]) {
    if (typeof t[k] === "string" && t[k])
      lines.push(...section(k[0].toUpperCase() + k.slice(1), [t[k] as string]));
  }
  return { title: `ARCS task — ${pick("title") || taskId}`, lines };
}

function asList(json: unknown): PlanSummary[] {
  if (Array.isArray(json)) return json as PlanSummary[];
  const plans = (json as { plans?: unknown } | undefined)?.plans;
  return Array.isArray(plans) ? (plans as PlanSummary[]) : [];
}

async function listPlans(cwd: string): Promise<PlanSummary[]> {
  const slug = await resolveSlug(cwd);
  if (!slug) return [];
  const res = await execArcs(["plan", "list", slug, "--json", "--lean"], cwd);
  return res.ok ? asList(res.json) : [];
}

async function readProposalLines(
  cwd: string,
  proposalId: string,
): Promise<{ title: string; lines: string[] }> {
  const slug = await resolveSlug(cwd);
  if (!slug) return { title: "ARCS proposal", lines: ["No ARCS project here."] };
  const res = await execArcs(["proposal-doc", "get", slug, proposalId, "--json", "--lean"], cwd);
  if (!res.ok) return { title: "ARCS proposal", lines: [truncate(res.raw, 300)] };
  const payload = res.json as { id?: string; status?: string; path?: string; body?: string };
  const lines = section("Proposal", [
    `${payload.id || proposalId}`,
    `status: ${payload.status || "pending"}${payload.path ? ` · ${payload.path}` : ""}`,
  ]);
  if (typeof payload.body === "string" && payload.body) {
    lines.push("Body", ...payload.body.split("\n"), "");
  } else {
    lines.push("(no body)", "");
  }
  return { title: `ARCS proposal — ${payload.id || proposalId}`, lines };
}

async function listProposals(cwd: string): Promise<Array<{ id: string }>> {
  const slug = await resolveSlug(cwd);
  if (!slug) return [];
  const res = await execArcs(["proposal-doc", "list", slug, "--json", "--lean"], cwd);
  if (!res.ok) return [];
  const raw = res.json;
  const arr = Array.isArray(raw)
    ? raw
    : ((raw as { proposals?: unknown } | undefined)?.proposals ?? []);
  return (Array.isArray(arr) ? arr : []).map((p) => ({
    id: String((p as { id?: unknown }).id ?? ""),
  }));
}

async function listTasks(cwd: string): Promise<Array<{ id: string; title: string }>> {
  const slug = await resolveSlug(cwd);
  if (!slug) return [];
  const res = await execArcs(["task", "list", slug, "--json", "--lean"], cwd);
  if (!res.ok) return [];
  const raw = res.json;
  const arr = Array.isArray(raw) ? raw : ((raw as { tasks?: unknown } | undefined)?.tasks ?? []);
  return (Array.isArray(arr) ? arr : []).map((t) => ({
    id: String((t as { id?: unknown }).id ?? ""),
    title: String((t as { title?: unknown }).title ?? ""),
  }));
}

// ---------------------------------------------------------------------------
// TUI modal reader (capturing overlay, keyboard scroll)
// ---------------------------------------------------------------------------

function wrapLines(lines: string[], width: number): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (!line) {
      out.push("");
      continue;
    }
    let rest = line;
    while (rest.length > width) {
      let cut = rest.lastIndexOf(" ", width);
      if (cut <= 0) cut = width;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    out.push(rest);
  }
  return out;
}

class ReaderModal implements ModalComponent {
  private title: string;
  private lines: string[];
  private offset = 0;
  private done: ModalDone;
  private theme: ModalTheme;
  private closed = false;

  constructor(title: string, lines: string[], theme: ModalTheme, done: ModalDone) {
    this.title = title;
    this.lines = lines;
    this.theme = theme;
    this.done = done;
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.done();
  }

  private pageSize(viewH: number): number {
    return Math.max(1, viewH - 4);
  }

  handleInput(data: string): void {
    const page = this.pageSize(20);
    switch (data) {
      case "q":
      case "Q":
      case "\x1b": // Esc
      case "\r":
      case "\n":
        this.close();
        break;
      case "j":
      case "\x1b[B": // ↓
        this.offset += 1;
        break;
      case "k":
      case "\x1b[A": // ↑
        this.offset = Math.max(0, this.offset - 1);
        break;
      case " ":
      case "f":
      case "\x1b[6~": // PgDn
        this.offset += page;
        break;
      case "b":
      case "\x1b[5~": // PgUp
        this.offset = Math.max(0, this.offset - page);
        break;
      case "g":
        this.offset = 0;
        break;
      case "G":
        this.offset = Number.MAX_SAFE_INTEGER;
        break;
      default:
        break;
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    const innerW = Math.max(20, Math.min(100, width - 6));
    const viewH = 24;
    const wrapped = wrapLines(this.lines, innerW);
    const maxOffset = Math.max(0, wrapped.length - this.pageSize(viewH));
    this.offset = Math.min(this.offset, maxOffset);
    const visible = wrapped.slice(this.offset, this.offset + this.pageSize(viewH));

    const border = (c: string): string => th.fg("border", c);
    const out: string[] = [];
    const title = ` ${this.title.slice(0, innerW - 8)} `;
    out.push(
      `${border("╭")}${th.fg("accent", title)}${border(`${"─".repeat(Math.max(0, innerW - title.length))}╮`)}`,
    );
    for (let i = 0; i < this.pageSize(viewH); i++) {
      const line = visible[i] ?? "";
      out.push(
        `${border("│")} ${line}${" ".repeat(Math.max(0, innerW - line.length - 1))}${border("│")}`,
      );
    }
    const pos =
      wrapped.length > 0 ? `${Math.min(this.offset + 1, wrapped.length)}/${wrapped.length}` : "0/0";
    const hint = ` j/k scroll · space page · g/G top/bottom · q close · ${pos} `;
    out.push(
      `${border("╰")}${th.fg("dim", hint.slice(0, innerW))}${border(`${"─".repeat(Math.max(0, innerW - Math.min(hint.length, innerW)))}╯`)}`,
    );
    return out;
  }

  invalidate(): void {}
}

async function showReader(ctx: ExtensionContext, title: string, lines: string[]): Promise<void> {
  const ui = ctx.ui as unknown as {
    custom<T>(
      factory: (
        tui: unknown,
        theme: ModalTheme,
        keybindings: unknown,
        done: (result: T) => void,
      ) => ModalComponent | Promise<ModalComponent>,
      options?: { overlay?: boolean },
    ): Promise<T>;
  };
  await ui.custom<void>((_tui, theme, _kb, done) => new ReaderModal(title, lines, theme, done), {
    overlay: true,
  });
}

// ---------------------------------------------------------------------------
// extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let revision = 0;
  let latest: Snapshot = { title: "ARCS", rows: [{ text: "loading…", role: "dim" }] };
  let fetching: Promise<void> | null = null;
  let panelTimer: ReturnType<typeof setInterval> | null = null;
  let webTimer: ReturnType<typeof setInterval> | null = null;
  let webPolling = false;
  let currentCwd = process.cwd();
  let active = false;

  const emitPanel = (type: "register" | "unregister", requestId?: string): void => {
    revision += 1;
    if (type === "register") {
      pi.events.emit(ATELIER_CHANNEL, {
        version: ATELIER_PROTOCOL_VERSION,
        type: "register",
        source: ATELIER_SOURCE,
        revision,
        panel: { id: ATELIER_PANEL_ID, title: latest.title, rows: latest.rows },
        ...(requestId ? { requestId } : {}),
      });
    } else {
      pi.events.emit(ATELIER_CHANNEL, {
        version: ATELIER_PROTOCOL_VERSION,
        type: "unregister",
        source: ATELIER_SOURCE,
        revision,
        id: ATELIER_PANEL_ID,
      });
    }
  };

  const atelierUnsub = pi.events.on(ATELIER_CHANNEL, (data) => {
    const event = data as { type?: string; requestId?: string };
    if (event?.type !== "discover" || typeof event.requestId !== "string") return;
    void refreshPanel(currentCwd, event.requestId);
  });
  void atelierUnsub;

  async function refreshPanel(cwd: string, requestId?: string): Promise<void> {
    currentCwd = cwd;
    if (fetching) {
      if (requestId) void fetching.then(() => emitPanel("register", requestId));
      return;
    }
    fetching = buildSnapshot(cwd).then((snapshot) => {
      latest = snapshot;
      emitPanel("register", requestId);
    });
    try {
      await fetching;
    } catch (e) {
      latest = {
        title: "ARCS",
        rows: [{ text: truncate(e instanceof Error ? e.message : String(e), 140), role: "error" }],
      };
      emitPanel("register", requestId);
    } finally {
      fetching = null;
    }
  }

  const updateWebStatus = async (ctx: ExtensionContext): Promise<void> => {
    if (webPolling) return;
    webPolling = true;
    try {
      const port = resolveWebPort();
      const up = await isWebServerUp(`http://127.0.0.1:${port}/api/health`);
      ctx.ui.setStatus(WEB_STATUS_KEY, `${up ? "●" : "○"} arcs-web 127.0.0.1:${port}`);
    } catch {
      ctx.ui.setStatus(WEB_STATUS_KEY, `○ arcs-web 127.0.0.1:${resolveWebPort()}`);
    } finally {
      webPolling = false;
    }
  };

  const openReader = async (args: string, ctx: ExtensionContext): Promise<void> => {
    const cwd = ctx.cwd ?? currentCwd;
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const kind = (parts[0] ?? "").toLowerCase();
    const target = parts[1];

    const needsTui = ctx.mode === "tui" && ctx.hasUI;
    const show = async (title: string, lines: string[]): Promise<void> => {
      if (!needsTui) {
        ctx.ui.notify(lines.slice(0, 5).join(" / ").slice(0, 300) || title, "info");
        return;
      }
      try {
        await showReader(ctx, title, lines);
      } catch (e) {
        ctx.ui.notify(
          `Reader unavailable: ${e instanceof Error ? e.message : String(e)}`,
          "warning",
        );
      }
    };

    if (!kind) {
      // No target: pick interactively in TUI, else show the brief.
      if (needsTui) {
        const options = [
          "brief — operating focus",
          "next — next ready task",
          "status — project counts",
          "plan — pick a plan to read",
          "proposal — pick a proposal doc to read",
          "task — pick a task to read",
        ];
        const picked = await ctx.ui.select("ARCS reader — what to open?", options);
        if (!picked) return;
        if (picked.startsWith("brief")) {
          const r = await readBriefLines(cwd);
          await show(r.title, r.lines);
          return;
        }
        if (picked.startsWith("next")) {
          const r = await readNextLines(cwd);
          await show(r.title, r.lines);
          return;
        }
        if (picked.startsWith("status")) {
          const r = await readStatusLines(cwd);
          await show(r.title, r.lines);
          return;
        }
        if (picked.startsWith("plan")) {
          const plans = await listPlans(cwd);
          if (!plans.length) {
            ctx.ui.notify("No plans found", "warning");
            return;
          }
          const planPicked = await ctx.ui.select(
            "Pick a plan",
            plans.map((p) => `${p.id} — ${p.title} [${p.status}]`),
          );
          if (!planPicked) return;
          const r = await readPlanLines(cwd, planPicked.split(" ")[0]);
          await show(r.title, r.lines);
          return;
        }
        if (picked.startsWith("proposal")) {
          const proposals = await listProposals(cwd);
          if (!proposals.length) {
            ctx.ui.notify("No proposal docs found", "warning");
            return;
          }
          const proposalPicked = await ctx.ui.select(
            "Pick a proposal doc",
            proposals.map((p) => p.id),
          );
          if (!proposalPicked) return;
          const r = await readProposalLines(cwd, proposalPicked.split(" ")[0]);
          await show(r.title, r.lines);
          return;
        }
        const tasks = await listTasks(cwd);
        if (!tasks.length) {
          ctx.ui.notify("No tasks found", "warning");
          return;
        }
        const taskPicked = await ctx.ui.select(
          "Pick a task",
          tasks.map((t) => `${t.id} — ${t.title}`),
        );
        if (!taskPicked) return;
        const r = await readTaskLines(cwd, taskPicked.split(" ")[0]);
        await show(r.title, r.lines);
        return;
      }
      const r = await readBriefLines(cwd);
      await show(r.title, r.lines);
      return;
    }

    if (kind === "brief") {
      const r = await readBriefLines(cwd);
      await show(r.title, r.lines);
    } else if (kind === "next") {
      const r = await readNextLines(cwd);
      await show(r.title, r.lines);
    } else if (kind === "status") {
      const r = await readStatusLines(cwd);
      await show(r.title, r.lines);
    } else if (kind === "plan" && target) {
      const r = await readPlanLines(cwd, target);
      await show(r.title, r.lines);
    } else if ((kind === "proposal" || kind === "proposal-doc") && target) {
      const r = await readProposalLines(cwd, target);
      await show(r.title, r.lines);
    } else if (kind === "task" && target) {
      const r = await readTaskLines(cwd, target);
      await show(r.title, r.lines);
    } else {
      ctx.ui.notify(
        "Usage: /arcs-open [brief|next|status|plan <id>|proposal <id>|task <id>]",
        "warning",
      );
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    currentCwd = ctx.cwd ?? currentCwd;
    active = true;
    if (!ctx.hasUI) {
      await refreshPanel(currentCwd);
      return;
    }
    await refreshPanel(currentCwd);
    await updateWebStatus(ctx);
    if (panelTimer) clearInterval(panelTimer);
    if (webTimer) clearInterval(webTimer);
    panelTimer = setInterval(
      () => void refreshPanel(currentCwd).catch(() => undefined),
      REFRESH_INTERVAL_MS,
    );
    webTimer = setInterval(
      () => void updateWebStatus(ctx).catch(() => undefined),
      WEB_POLL_INTERVAL_MS,
    );
  });

  pi.on("session_shutdown", () => {
    active = false;
    if (panelTimer) {
      clearInterval(panelTimer);
      panelTimer = null;
    }
    if (webTimer) {
      clearInterval(webTimer);
      webTimer = null;
    }
    emitPanel("unregister");
  });

  pi.on("turn_end", (_event, ctx) => {
    if (active) {
      void refreshPanel(ctx.cwd ?? currentCwd).catch(() => undefined);
      if (ctx.hasUI) void updateWebStatus(ctx).catch(() => undefined);
    }
  });

  pi.on("agent_end", (_event, ctx) => {
    if (active) void refreshPanel(ctx.cwd ?? currentCwd).catch(() => undefined);
  });

  pi.registerCommand("arcs-open", {
    description: "Read ARCS plans/proposals/tasks/brief in an interactive TUI modal",
    handler: async (args, ctx) => {
      await openReader(args, ctx);
    },
  });

  pi.registerCommand("arcs-web", {
    description: "Open the ARCS web UI (current project when resolvable)",
    handler: async (_args, ctx) => {
      const port = resolveWebPort();
      const slug = await resolveSlug(ctx.cwd ?? currentCwd);
      const url = slug ? `http://127.0.0.1:${port}/p/${slug}` : `http://127.0.0.1:${port}`;
      openBrowser(url);
      ctx.ui.notify(`Opening ${url}`, "info");
    },
  });

  pi.registerCommand("arcs-refresh", {
    description: "Refresh the ARCS panel and web status",
    handler: async (_args, ctx) => {
      await refreshPanel(ctx.cwd ?? currentCwd);
      if (ctx.hasUI) await updateWebStatus(ctx);
      try {
        ctx.ui.notify("ARCS panel refreshed", "info");
      } catch {
        /* ui not available */
      }
    },
  });
}
