# Rework Ask-AI sidebar: pi-first runner selection, localStorage sessions, web port & pi status

## Goal

Rebuild the Ask-AI sidebar (and its server side) around a **selectable runner
model**: pi becomes the default runner for web→AI interaction, with codex,
opencode and claude-code also selectable and the user's choice persisted in
localStorage. The session layer is reworked so the *browser* owns the
conversation (localStorage as session manager) instead of ARCS-owned server
threads driven by remnants of the old hook/session-bridge machinery. The web
server moves off its conflict-prone default port, and a small pi extension
surfaces arcs-web's up/down status in pi's own footer.

## Motivation / Non-goals

Motivation:

- The one-shot CLI bridge (plan "One-shot CLI session bridge (opencode first)")
  removed the hooks, but the session stack is still shaped by them: a session-
  store, transcript sidecar mirroring, per-thread uuid seed/resume in the
  claude-code path, and dead compiled hook artifacts in `dist/`. All of it
  exists to make ARCS "own" threads that the browser should simply own.
- pi is the environment's primary agent (and already wired into `arcs init` +
  subagent deploy), but the web UI can only drive opencode (default) or legacy
  claude-code. There is no pi driver, no runner choice, and the UI hardcodes
  "opencode" in several places.
- The port 4173 collides with `vite preview`'s default; the web UI should live
  on an uncommon port.
- The user wants arcs-web's health visible inside pi.

Non-goals:

- No changes to CLI-side ARCS, the opencode agent bundle, prompts, or skills.
- No migration of existing server-side Ask-AI thread transcripts into
  localStorage — the server mirror is dropped (history is whatever the browser
  has; a cleared browser starts a fresh conversation).
- No new session-entity surface: sessions CRUD, linking, status badges and the
  "recent sessions" overview panel are removed, not repaired.
- Reviewing tool *behavior* of each runner (their sandbox models etc.) is out
  of scope; ARCS maps intent → the runner's own read-only/edit flags.

Note: the `ask`/`change` intent machinery is being REMOVED for the MVP (see
below) — the final non-goal is: **no runtime permission management**. Runners
run with their full tool surface (allow-all); the safety gate moves to a
post-run diff review in the web UI (approve / reject).

## Current state

- **Panel**: `web/src/components/AskAIPanel.tsx` — one implicit thread per
  project via the server's virtual `ask` alias; composer with intent select
  (`ask` read-only / `change` may-edit); checkpoint-mirrored transcript
  (`web/src/api/hooks.ts` `useSessionTranscript` polling
  `GET /sessions/ask/transcript`); live run tail over SSE
  (`web/src/api/sse.ts` `useRunStream` + `foldRunLine`). Hardcoded runner
  identity: `<Badge color="purple">opencode</Badge>`,
  `RUN_STREAM_LABEL` "starting opencode…", quiet-head copy "opencode is
  booting…".
- **Server**: `src/web-server/routes/sessions.ts` — full sessions CRUD; `ask`
  resolves-or-mints an ARCS-owned `ask-ai` thread in the session-store
  (`src/utils/session-store.ts`); `POST /:id/turns` runs one-shot via the
  run-driver seam (`src/web-server/run-driver.ts`, opencode adapter) or the
  legacy claude-code path (uuid seed/resume, `repairThreadSeed`, staged
  environment in `prompt-assembly.ts`, permission argv in
  `permission-policy.ts`). Generic lifecycle (claim, concurrency slot, durable
  event log, timeout) in `claude-runner.ts` + `run-event-log.ts`; run stream
  tail in `sessions.ts` (SSE line/end frames).
- **Session residue**: `src/shared/session-vocabulary.ts` +
  `web/src/components/SessionStatusBadge.tsx`; sidecar mirroring in
  `src/utils/claude-transcript.ts`; dead dist artifacts
  `dist/utils/hook-contract.*`, `hook-token-store.*`,
  `claude-code-hook-install.*`; unused UI components `SessionLinkModal.tsx`,
  `NewThreadDialog.tsx` (no import sites), `SessionMessageForm.tsx` (only
  `MAX_LENGTH`/`WARN_LENGTH` imported); overview "recent sessions" panel
  (`web/src/routes/overview.tsx:425`) navigates to `/sessions`, a route that
  does not exist in `web/src/router.tsx`.
- **Port**: `DEFAULT_WEB_PORT = 4173` in `src/web-server/index.ts` and
  `src/cli/commands/web.ts`; `web/vite.config.ts` dev proxy hardcodes
  `http://127.0.0.1:4173` (dev server itself on 5173). 4173 is Vite preview's
  default → conflict-prone.
- **Runners available on this machine**: pi 0.84.4, opencode 1.18.25,
  codex 0.150.1, claude 2.1.247.
- **pi headless facts** (verified against 0.84.4): `pi -p --mode json <msg>`
  emits one JSON line per event — session header `{"type":"session","id":…}`
  (session id harvestable), then `agent_start / turn_start / message_start /
  message_update (delta-only text via assistantMessageEvent) / message_end /
  tool_execution_start{id,toolName} / turn_end / agent_end`. Session machinery:
  `--session-id <id>` (exact project session id, created if missing),
  `--session-dir <dir>`, `--session <path|id>`, `--continue/-c`,
  `--resume/-r`, `--no-session`. Tool policy: `--tools/-t` allowlist,
  `--no-tools/-nt`, `--no-builtin-tools/-nbt`, `--approve/-a`. Status in pi:
  extension API `ctx.ui.setStatus(key, text)` (setStatus RPC; see
  docs/extensions.md + examples/extensions/model-status.ts).

## Proposed design

### 1. Remove hook/session-bridge residue

- Delete `dist/utils/hook-contract.*`, `dist/utils/hook-token-store.*`,
  `dist/utils/claude-code-hook-install.*` (dead compiled artifacts; sources
  already gone from src/).
- Delete the legacy claude-code thread machinery in
  `routes/sessions.ts` / `prompt-assembly.ts` / `permission-policy.ts`:
  uuid seed/resume targeting, `repairThreadSeed`, `metadata.threadInitialized`
  / `claudeSessionId`, staged-environment W2. `permission-policy.ts` itself
  (and `RUN_INTENTS`) is DELETED, not relocated — the MVP runs allow-all (see
  2) with the diff review as the gate.
- Delete the sessions entity: `session-store.ts`, transcript sidecar mirroring
  (`claude-transcript.ts`), `session-vocabulary.ts` + client mirrors,
  `SessionStatusBadge/NewThreadDialog/SessionLinkModal`, sessions CRUD routes
  and the overview "recent sessions" panel. The Ask-AI panel becomes the only
  chat surface; nothing else references sessions.
- Keep, unkeyed-by-session: the runner lifecycle (`claude-runner.ts`),
  durable event log + SSE tail (`run-event-log.ts` + stream route), which move
  under a per-run key (see 3).
- Remove the `install-Codex-hook` skill and any `scripts/` references to the
  bridge (user decision: remove, not archive).

### 2. Runner registry: pi default, selection persisted in localStorage

- Extend `run-driver.ts` registry to four runtime types, **pi first**:
  `pi`, `opencode`, `claude-code`, `codex`. Each driver keeps the seam shapes
  (`buildArgv` fresh/continued, `foldOutput` NDJSON→fold turns + harvested
  session id).
  - **pi (new, shipped first, default)**: fresh `["-p","--mode","json",
    message]`; continue adds `--session-id <id>` (+ `--session-dir`
    pinned under the project data dir so pi's store is stable across cwd);
    fold text deltas (`message_update.assistantMessageEvent` text/thinking)
    into assistant turns, `tool_execution_start` into tool turns; harvest the
    id from the session header line.
  - opencode: existing adapter unchanged.
  - claude-code (new driver replacing the legacy path): `claude -p
    --output-format json` + allow-all flag (see policy note below); continue
    via `--resume <id>`; reuse the claude reader in `claude-runner.ts`.
  - codex (new): fresh `codex exec --json --sandbox workspace-write "<msg>"`;
    continue `codex exec resume <id> --json --sandbox workspace-write
    "<msg>"`; fold codex JSONL events. Secondary priority — opencode/claude
    first, codex after pi.
- **No permission segment in the MVP — allow-all** (user decision): the
  `ask`/`change` intent machinery is removed end-to-end (server
  `RUN_INTENTS`/`permission-policy.ts`, the panel intent select, the
  `intent` field in the turn payload and in the write-back `mode`). Every
  runner spawns with its full tool surface: pi default tools (non-interactive
  `-p` runs full policy); opencode unchanged; claude needs
  `--dangerously-skip-permissions` so a headless run never blocks on a
  prompt; codex `--sandbox workspace-write` with the auto-review/bypass
  combination chosen and verified during driver tests. **The safety gate
  moves to the web UI**: after each run the panel renders the workspace diff
  the run produced and the user approves (keep) or rejects (revert) — no
  runtime permission handling anywhere.
- **Selection**: the panel gains a runner `<select>` (pi, opencode,
  claude-code, codex — pi first, default). The user's pick is persisted to
  localStorage (`arcs:askai:runner`); the server returns the available runner
  list (registry + binary-detected) so the UI disables missing binaries.
  The turn payload carries `runner`; the server 400s unknown runners and
  resolves the driver from it (a /sessions-record runtimeType is no longer the
  source of truth).

### 3. Local-session model: localStorage as the session manager

- The Ask-AI transcript lives in localStorage, keyed per project AND per
  runner (`arcs:askai:<slug>:<runner>`), replacing the server-side sidecar +
  mirror. One conversation per runner (user decision) — exactly one thread per
  (project, runner), no switcher in this pass; the key layout makes a
  conversation list a cheap follow-up. The panel reads history from
  localStorage (survives reload; "clear conversation" action added).
- The turn endpoint becomes stateless w.r.t. threads: `POST /api/p/:slug/ask`
  accepts `{runner, message, refs, history?}` (no `intent` — allow-all, see
  2); the server renders the message + capped prior history block + refs into
  the prompt, snapshots the workspace (git status/diff baseline, or a
  file-hash manifest outside git), spawns via the driver, returns 202 with
  `{runId, streamUrl}`; the run's durable log is keyed by runId alone (no
  session id), and the existing SSE tail serves the live block unchanged. The
  client appends the full reply to localStorage on settle (reconnect-safe:
  the SSE `from` cursor already resumes drops). The write-back stamps
  `metadata.run.mode` with the RUNNER name (was intent).
- **Diff review — the safety gate (user decision)**: on settle the server
  diffs the workspace against the snapshot, persists the change manifest
  beside the run's event log, and serves it as `GET /runs/:runId/changes`;
  the panel renders a review card (changed paths + per-file +/- diff) with
  **approve** (keep) and **reject** (revert: `git restore -- <paths>` for git
  workspaces, manifest reversal outside git). The turn's local transcript row
  carries the review state (pending / approved / reverted); runs that changed
  nothing show no card.
- Continuation (hybrid — user decision): the client also stores the last
  `runtimeSessionId` per (project, runner) in localStorage; when present the
  driver continues (`pi --session-id`, `codex exec resume`, `claude --resume`,
  `opencode -s`) instead of forking — but the capped rendered history still
  rides each turn so a continuation loss cannot lose the conversation. If a
  continuation fails for a reason the driver reports as "unknown id", the
  client clears the id and re-sends fresh. This keeps continuity without any
  server-side thread record; a cleared browser starts fresh.
- Server-side: the `ask-ai` record, `resolveAskThread`, `resolveTurnTarget`,
  `isRunLive` per write-target and session-index machinery all go away with
  the sessions entity. Run claims still gate one-live-run-per-project
  (keyed by slug rather than thread).

### 4. Ask-AI panel rework + improvement notes (UX audit)

Rework (from the gaps below):

- **Composer moves to the BOTTOM of the panel** — the layout order becomes
  header → workspace files → transcript (scrollable, flex-1) → composer, so
  the input sits at the conversational edge instead of above old transcript
  content. The panel scrolls to the newest turn on open and after each reply.
- **Agent replies render as markdown**: both the live stream block and folded
  assistant turns render through a lightweight chat-markdown component
  (ReactMarkdown + remark-gfm + rehype-highlight — the same deps
  `MarkdownViewer.tsx` already pulls, minus the TOC rail, heading anchors and
  send affordance that belong to document viewing). Code blocks, tables and
  lists render instead of raw pre-wrap text. User turns and tool turns stay
  plain text.
- Runner select in the header (replaces the hardcoded "opencode" badge);
  the old intent select is REMOVED (allow-all) and a pending-changes review
  card renders the per-run workspace diff with approve / reject.
- Replace "starting opencode…"/"opencode is booting…" with runner name from the
  selection ("starting pi…").
- Cancel/stop button on a running turn (kills the child via a `DELETE
  /runs/:runId` or runner kill; marks the local turn failed).
- Inline error row in the transcript on send failure + retry affordance
  (toaster alone is insufficient once the transcript is local).
- Clear-conversation action + copy/export transcript.
- Transcript reads from localStorage (always current, no "last mirror …"
  staleness UI).
- Remove the dead `/sessions` navigation; delete unused components.

Improvement notes (from the audit; not all are fixes in this pass):

1. Hardcoded runner identity (badge, stream labels, quiet-head copy) — fixed.
2. No cancel/stop for a running run — fixed.
3. No server-lost/stream-failed state in the panel — add a connection notice
   (SSE failed) that does not claim "the reply still lands" falsely when the
   browser holds the session.
4. Transcript staleness ("checkpoint-mirrored, never live") disappears with
   localStorage.
5. Dead `/sessions` navigation + orphan "recent sessions" panel — removed.
6. Unused components (NewThreadDialog, SessionLinkModal, SessionMessageForm)
   — deleted.
7. Single implicit thread only — localStorage enables per-runner conversations;
   MVP: one per runner, switcher later (open question 2).
8. The ask/change intent select (claude-shaped copy: "plan mode",
   "acceptEdits") is removed — the MVP runs allow-all and gates on the
   per-run diff review instead (fix).
9. Character ceiling (MAX_LENGTH/WARN_LENGTH) is arbitrary and only client-
   side; keep as-is but mention runner-specific truncation in the hint when a
   runner is known to truncate.
10. Panel is `hidden lg:flex` — unreachable below the lg breakpoint; convert
    to a slide-over (small, but it is a real accessibility gap).
11. No keyboard focus management (no Esc-to-close, composer focus shortcut
    after toggle) — add keydown focus-on-open.
12. Run history beyond the current transcript is not browsable; localStorage
    keeps prior conversations — one-per-runner keys make a list a cheap
    follow-up (out of scope this pass).
13. The composer sits ABOVE the transcript (chat convention is input at the
    bottom) and the panel does not scroll to the newest turn — flipped:
    composer at bottom, auto-scroll on open/reply (fix).
14. Agent output renders as plain pre-wrap text — code blocks, tables and
    lists do not render in chat — switched to a lightweight markdown renderer
    for the live block and assistant turns (fix).

### 5. Web port: uncommon default + persisted override

(Decision: fixed uncommon default + persisted override, confirmed.)

- `DEFAULT_WEB_PORT` 4173 → 8745 (uncommon; outside common dev ranges) in
  `src/web-server/index.ts` and `src/cli/commands/web.ts`.
- First `arcs web` start persists the resolved port to the ARCS data dir
  (`web-config.json`, alongside `web-token.json`); later starts reuse it so
  the URL is stable across restarts; `--port` still overrides.
- `web/vite.config.ts` dev proxy reads the persisted port (fall back to 8745)
  instead of hardcoding 4173.

### 6. arcs-web status inside pi

- New pi extension `web/extensions/arcs-web-status.ts` (extension API like
  `examples/extensions/model-status.ts`): on load and every ~5s, GET
  `http://127.0.0.1:<port>/api/health` (port read from the persisted
  `web-config.json`, else 8745) and call `ctx.ui.setStatus("arcs-web", …)`
  showing the URL + up/down glyph; clear the entry when the server stops.
  Optional: `registerCommand("arcs-web")` to open the UI.
- Install path: file in the repo + documented `pi install`/`-e` usage (pip
  README section); auto-install via `arcs init` is an optional follow-up.

## Impact & risks

- **Blast radius**: `routes/sessions.ts` (+ ~1.5k lines), session-store,
  claude-transcript, shared session vocabulary, several web components, tests
  across the sessions surface (sessions-route*, session-store, claude-run*,
  claude-transcript, prompt-assembly-refs, permission-policy). Bundle
  (opencode/arcs) is untouched except nothing references sessions — verify by
  grep. `arcs web` port change affects any saved bookmark/URL.
- **Data**: server-side Ask-AI history is dropped (non-goal above); users lose
  cross-browser continuity — accepted, and called out in the UI copy? Out of
  scope for the retention question (localStorage clears with the browser).
- **Risk — pi continuation**: `--session-id` semantics are project-scoped and
  `--session-dir` placement matters; mitigate with the clear-and-refresh
  fallback in 3 and driver tests against the real binary.
- **Risk — codex driver**: codex JSONL event vocabulary is large; fold only
  the message/tool events the panel needs (same tolerance the opencode
  normalizer applies — skip+count drift). codex is lowest priority.
- **Risk — allow-all runs**: runs may modify the workspace by design; the
  diff review is the gate. Non-git workspaces rely on the file-hash manifest
  (revert fidelity = manifest). claude needs `--dangerously-skip-permissions`
  headless — driver-documented and pinned by a driver test.
- **Risk — runner availability**: a selected runner whose binary is missing
  must fail clearly (400/502 with a readable message + UI disabled state),
  never hang.
- **Ordering**: pi driver + localStorage model + UI rework first (the core
  ask), then opencode/claude/codex adapters, then port + status. Proposal
  docs, plans, tasks and bundle prompts move together (README + any
  session-referencing prompts checked).

## Acceptance criteria

1. Ask-AI runs one-shot turns through pi by default; the runner select shows
   pi/opencode/claude-code/codex (pi first), persists the choice in
   localStorage across reloads, and disables a runner whose binary is absent.
2. Live stream + tool ticker work for pi (fresh and continued turn); fold
   turns land in the transcript; a mid-run browser reload resumes the stream
   without duplicating text.
3. No session-store record, sidecar file, or `ask-ai` thread is created by the
   Ask-AI flow; dead hook artifacts and unused session components are gone;
   the legacy claude seed/resume/repair + staged-environment code is gone,
   and `permission-policy.ts` / `RUN_INTENTS` / the `intent` payload field
   are gone; affected tests updated or removed; `npm run lint`/`typecheck`
   and vitest green; bundle lint-pass.
4. Transcript survives reload from localStorage; clear-conversation and
   per-runner isolation work; a failed continuation self-heals by re-seeding.
5. `arcs web` defaults to the uncommon port (8745 or the persisted value),
   `--port` still overrides, vite dev proxy no longer hardcodes 4173.
6. The pi extension shows arcs-web up/down in pi's footer (install doc added);
   status clears when the server stops.
7. No hardcoded "opencode" text remains in the panel; the composer sits at the
   bottom with auto-scroll; agent replies render markdown (code blocks/tables
   visible) in both the live block and the transcript; cancel/stop, inline
   error row, and the removed dead-route panel are verified in the UI.
8. Every turn runs allow-all: no intent select and no runtime permission
   prompts from any runner. After a run that changed the workspace, the panel
   shows the diff review card; approve keeps the changes and reject reverts
   them (`git restore` or manifest reversal); a changed-nothing run shows no
   card, and each transcript row carries its review state.

## Decision

*Approved: _when_ — rationale: _rejected alternative summaries_*