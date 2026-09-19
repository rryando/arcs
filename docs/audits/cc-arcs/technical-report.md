# cc-arcs → arcs technical report (DRAFT)

Companion to [README.md](./README.md). Status: **DRAFT / pending approval**. The audit
**preserved implementation source and existing project records** (tasks, plans, diagrams,
knowledge); it added **new documentation** and a **pending proposal**, and performed
mutations **only inside an isolated fixture data dir** for the dry-run reproduction. It
made no deploy or Git change. Evidence provenance and confidence tags are defined in the
[README legend](./README.md#evidence-provenance-and-confidence-legend).

## 1. Revision and worktree caveats

- **Target** `/home/rryando/Work/arcs` (`@rryando/arcs` 5.2.3), HEAD
  `a9e7e1bddb405aad1d2e9d70420b525f76b3cec1`, ancestry root
  `ca04f0f4ab87936c76b49cfbaaf0eebf32e23b2a`, 348 commits.
- **Donor** `/home/rryando/Work/agent/cc-arcs` (`@traveloka/cc-arcs` 0.9.0), HEAD
  `b9c9f6380db9f823111e75415bf124bf34a10e02`, ancestry root
  `d9b8427c84149bd666a5b86f7e45467deabcdbd1` ("initial commit — CC-ARCS, rebranded
  fork of arcs"), 66 commits.
- **The target is a live, mutable user worktree.** It grew from **10 modified tracked
  files at the initial gate run (~01:12–01:13 UTC)** to **23 modified tracked files at
  audit close**. Every claim describes the working-tree state at its capture time, **not**
  an immutable HEAD-only baseline; **target source is unchanged by the audit**, not
  "the worktree is unchanged".
- **Gate timing/snapshots (do not conflate):** the `npm test` / `typecheck` / `lint`
  runs executed at ~01:12–01:13 UTC against the **~10-file** state and were **not
  re-run** after later edits, so they do **not** validate the final 23-file state.
  `lint-bundle` and the web typecheck were **later, separate** checks. Details in
  [verification.md](./verification.md) and §7.
- **Donor was not executed**: no `node_modules`, no `dist/`, and the audit was
  constrained to no install. The donor being unindexed is not the limiting factor; the
  missing dependencies/dist are.

### 1.1 Git ancestry and porting feasibility [X]

- The two repos share **zero reachable commit IDs** (main: `comm` of both
  `git rev-list HEAD`). The donor root is a **re-initialized single-commit snapshot**,
  not a true git fork.
- This does **not** mean zero shared objects: content-identical tracked files share
  content-addressed blob hashes. The release worker measured 42 byte-identical files
  out of 368/760 tracked blobs. **Semantic comparison is the primary method**; blob/path
  comparison is a supplementary signal, not the only meaningful basis.
- Cherry-pick is **not impossible**: it would require importing the donor's objects into
  the target's object store first (e.g. `git fetch` a remote/tag). No patch application
  was attempted, so an exact conflict count is unknown; based on pervasive rebranding
  (`arcs`→`cc-arcs`, `scripts/arcs-*`→`scripts/cc-arcs-*`), **substantial conflicts are
  expected**.
- **Recommendation: selective reimplementation.** The content-similarity peak near target
  `3.9.x` (late July 2026) is a **content-similarity estimate, not a proved fork point**.

## 2. Method and boundaries

- **Read-only for implementation and project records.** No builds, installs, network,
  servers, or repository mutations. The only mutations were inside an isolated
  `ARCS_DATA_DIR` fixture used to reproduce the dry-run defect (**[E]**).
- **Static CLI extraction** via TypeScript compiler API over `src/cli/commands/*.ts`
  `defineCommand({...})` literals, resolving top-level param references and spreads.
  Full method in [cli-compatibility-inventory.md](./cli-compatibility-inventory.md).
- **`jev_*` unavailable** (`no_api_key`): every invocation that was made returned
  `unavailable`; not every worker invoked the tools. No probabilistic verdict exists;
  all severity/confidence labels are manual and source-backed.

### 2.1 Audited vs. uninspected boundary ("audit all" interpretation)

"Audit all" = inventory every major surface with **partial, high-risk-path inspection**;
it is **not** exhaustive line-by-line coverage. Subsystems below were **partially**
inspected — treat "inspected" as subsystem-level, not file-exhaustive.

Partially inspected (source read, high-risk paths):

- **CLI**: registry extraction, arg-parser, router, batch op namespace, global flags.
- **Delegation**: orchestrator prompt composition, agent registry/manifest, Pi deploy,
  subagent tuning, worktree orchestration, write-gate.
- **Reporting/evidence**: receipts, report store/CLI/API, code chunks, run/session stores.
- **Domain/storage**: knowledge/plan/task/proposal stores, retrieval index/graph,
  codegraph ingestion, config schema, donor journal/gate-machine/artifact-service.
- **Web/security**: target Hono server (auth, security, runner, run-store, routes) and
  donor console/pairing servers, doc-turn runtimes, markdown/mermaid pipeline — **web
  scope covered high-risk paths only; many UI components were not read**.
- **Release/build**: package manifests, install/setup/upgrade scripts, packaging/deploy
  ownership, CI/release workflows, licensing, README accuracy, tracked inventory.

Not exhaustively covered (partial only, or header-level):

- Target: `src/web-server/routes/{projects,collections,discovery,proposal-docs}.ts`
  detail, `watcher.ts`, `ask-prompt.ts`, `run-event-log.ts` body, most `web/src/routes/*`
  and UI components (`AskAIPanel.tsx`).
- Donor: `src/workflow/console-read.ts`, most of the 168-file console UI,
  `doc-turn/section-turn-service.ts` body beyond guards, `retry.ts`/`parse-result.ts`/
  `from-config.ts` bodies, parts of `setup-*`/`pi-*`/`skill-*`, bundle/presets, most of
  both web frontends. Some of these were read at high-risk paths by other scoped
  agents (`setup-*`/`pi-*`, `console-read.ts`, both frontends partially).
- Not run: donor test suite (no deps), either `build`/`build:web`/prepack, CI/release
  workflows, Node-20 runtime floor, any live HTTP probe.

## 3. Architecture maps

### 3.1 Shared design (both repos)

Both are **dispatch-first**: `PARSE → DISPATCH → COLLECT → SYNTHESIZE → REPORT`, an
orchestrator owning routing/state and sub-agents owning exactly one outcome and
returning a compact envelope. Divergence is concentrated in the **enforcement layer**
(CLI-side in target, runtime/config-side in donor), not the prose layer.

### 3.2 Target delegation chain [C]

- Prompt composition SSOT: `src/cli/orchestrator-shared-blocks.ts`; split/composed by
  `src/cli/arcs-orchestrate.ts`, `src/cli/arcs-flash.ts`, `src/cli/arcs-orchestrate-caveman.ts`.
  The `PROMPT_BODY` split and a `JEV_JUDGMENT_BLOCK` are **worktree-only user edits** [X].
- Mirrors: `scripts/build-opencode-bundle.mjs` compiles only the **3** orchestrator
  prompts; the **5** typed sub-agent prompts are hand-authored static `.txt` that
  **duplicate** the shared Trust/Scope + Role Boundary + Return blocks (findings T2 → roadmap PORT-16).
- Registry: `opencode/arcs/manifest.json` drives `src/cli/agent-registry.ts`
  (zod-validated, retired-role replacement checks).
- Three primaries + five sub-agents; `oncall-ops`, `docs-researcher`, `devil-advocate`
  are **retired** with replacements, encoded by tests (§6).
- Enforcement: `src/cli/write-gate.ts` (`ARCS_GUARDED=1` → `--token`), plus the
  plan-scoped worktree registry (`src/cli/commands/worktree.ts`, `src/utils/worktree-store.ts`).

### 3.3 Donor delegation chain [C]

- Same `orchestrator-shared-blocks.ts` **plus** a fragments module
  (`src/cli/prompts/fragments.ts`) consumed by every sub-agent prompt — the SSOT the
  target lacks.
- Per-agent prompt **TS modules** compiled by `scripts/build-opencode-bundle.mjs` into
  `bundle/cc-arcs/agents/<owner>/<stem>.md`.
- Registry SSOT `src/cli/agents.ts` `AGENT_REGISTRY` → `AGENT_TIER_MAP` → manifest/deploy/picker.
- **9** active sub-agents incl. roles target retired.
- Runtime: a **vendored hardened `pi-subagents` fork** plus a subagent-tool extension
  and a **16-entry Pi extensions catalogue** with state file + revert.

### 3.4 Reporting / evidence model [C]

- **Target = "captured content":** `src/utils/run-report.ts captureReceipt` produces
  a SNAPSHOT (`base → working tree`, untracked synthesized) or COMMITTED RANGE
  (`--commit`); stored as `<dataRoot>/projects/<slug>/reports/<id>.json` + `.diff` via
  `src/utils/report-store.ts`; `dirty`/`untracked` describe repo state independently.
  `CodeChunk`s live on knowledge meta and are mined from receipt diffs by `done --learn`.
- **Donor = "git citation ledger + doc provenance":** append-only
  `src/workflow/change-ledger.ts` JSONL stores **diffstat + hunk headers, never patch
  bodies**; tasks carry `baselineCommit`, `sourceFiles`, `docRefs`; promotion journal
  with `started/committed/failed`; dispatch brief assembles
  GOAL/SCOPE/CONTEXT/VERIFY/STOP; `validate --checks=changes,citations` adds provenance checks.

### 3.5 Web/security [C]

- **Target:** Hono `src/web-server/app.ts`; loopback Host + Origin checks
  (`security.ts`); per-process 32-byte `X-ARCS-Token` with `timingSafeEqual`
  (`web-auth.ts`/`web-token.ts`); runner adapter registry `run-driver.ts`;
  `claude-runner.ts`; durable `run-event-log.ts` (32 MB cap); `run-store.ts`
  (per-run claim, pid liveness); `run-diff.ts` (snapshot/diff/revert).
- **Donor:** hand-rolled `src/workflow/console-server.ts`; `pairing-server.ts`
  loopback/Origin/token/SSE; `doc-turn/section-turn-service.ts` integrity-gated
  propose→approve writer; `doc-turn/{claude,pi}-runtime.ts` least-privilege flags;
  168-file `web/src/console`.

### 3.6 Release/build [C]

- Target: `files` = dist/scripts/templates/skills/opencode/web-extensions; web is a
  separate workspace `@arcs/web`; CI single job, Node hard-pinned 24, gates
  `typecheck → lint → build:opencode-bundle → test → lint-bundle`; manual
  `workflow_dispatch` release; **no postinstall**; **no LICENSE file**.
- Donor: single package with root devDeps; `files` includes `bundle/` (209 tracked
  generated files) and `web/dist/`; CI matrix `node-version: [22]`; tag-triggered
  release with `tag == package.json version` gate, idempotent publish, `gh release`;
  global-install-guarded `scripts/cc-arcs-postinstall.mjs`; migration for retired runtimes.

## 4. Feature / decision matrix

Legend: **[C]/[E]/[I]/[U]/[X]** as per README; "Decision" is the documentation owner's
unscored judgment. Roadmap IDs in the Decision column where applicable.

| Surface | Target | Donor | Decision |
|---|---|---|---|
| Write-gate `ARCS_GUARDED` + `--token` | present (`src/cli/write-gate.ts`) [C] | absent [C] | **Preserve target (P0)** |
| Plan-scoped worktree registry CLI | present (`worktree.ts`, `worktree-store.ts`) [C] | absent; per-agent ephemeral worktree [C] | **Preserve target; don't enable two models** |
| Receipts + code chunks | present (`run-report.ts`, `report-store.ts`, `code-snippet.ts`) [C] | ledger + docRefs, no patch bodies [C] | **Preserve; write-ordering/diagnostics + staleness (PORT-07)** |
| Parser hardening (`-h`, kebab alias, value guard) | absent [C] | present (`arg-parser.ts`) [C] | **Port (PORT-02), keep `--token`** |
| Central dry-run refusal predicate | absent [C]; `--dry-run` executes mutations [E] | present (`command-registry.ts`/`index.ts`) [C] | **Port (PORT-01)** |
| General/group help + `--version` + unknown-cmd suggestion | wrapper-only **minimal static** help (exit 0); internal `dist/index.js --help`/`--version` exit 1; no `-h`/group help [E] | registry-driven help + `--version`/`-v` [C] | **Port (PORT-03)** |
| `task brief` dispatch contract | absent [C] | present (`task-brief.ts`) [C] | **Port on existing data (PORT-06)** |
| Additive task changes ledger | absent [C] | present (`change-ledger.ts`) [C] | **Port additive, receipt-indexed (PORT-08)** |
| Generalized docs (tech-doc/design-doc, `doc promote`) | absent; **existing `doc update` + `proposal-doc` must be preserved** [C] | present (`src/utils/doc-store.ts`, `doc-*`) [C] | **Opt-in only (PORT-09)** |
| Pinned citations / `validate --checks=changes,citations` | absent [C] | present [C] | **Fold into PORT-07/09** |
| Config `tryReadConfig` + migration-before-validate | `process.exit(1)` [C] | `{ok:false,issues}` + migration [C] | **Port (PORT-05)** |
| `taskMetaSchema` completeness | under-declares `TaskMeta` [C] | declares most + round-trip test [C] | **Port union + test (PORT-04)** |
| Schema richness (agent registry) | richer (`agentTierSchema`/prompt-path) [C] | simplified | **Keep target** |
| Storage durability | `writeTextAtomic`/`writeFilesTransaction` [C]; best-effort rollback, **not crash-atomic** [C] | plain `writeFile` [C] | **Reject donor storage; keep target** |
| Sub-agent prompt SSOT | absent (5 duplicated `.txt`) [C] | present (`prompts/fragments.ts`) [C] | **Port (PORT-16)** |
| Retrieval core (bm25/graph/toposort/…) | = donor (identical) [C] | = target | **No action** |
| Retrieval `index-builder` | ahead (chunks field, sourceSignature) [C] | older | **Keep target** |
| Cross-project knowledge search | **already present** (`src/retrieval/cross-project-search.ts`) [C] | adds listing helper (`listKnowledgeAcrossProjects`/`CrossProjectKnowledgeEntry`) [C] | **Already-present; optional ADAPT helper only if demand (PORT-11)** |
| Graph doc edges | absent [C] | present [C] | **Port doc edges with PORT-09; ledger edges only with PORT-08** |
| codegraph ingestion + anchors | ahead [C] | behind [C] | **Keep target; add realpath containment policy (PORT-17)** |
| Knowledge `stub`/`commits` fields | absent [C] | present [C] | **Optional additive (metadata-only) — PORT-08** |
| Runner permission scoping | allow-all + post-hoc diff gate [C] | least-privilege flags [C] | **Opt-in mode only (PORT-12)** |
| Markdown/XSS pipeline | **raw-HTML off already safe** [C] | sanitized rich pipeline + tests [C] | **Default rawHTML-off stays; richer HTML is an optional separate capability (PORT-13)** |
| Body-size caps | absent on ask path [C] | present [C] | **Port cap independently (PORT-13)** |
| Mermaid config hardening | omits `htmlLabels:false` [C] | hardens + DOMPurify labels [C] | **Port default-safe hardening (PORT-13)** |
| Release workflow | manual, no tag gate [C] | tag-triggered, tag==version, idempotent [C] | **Adopt safety gates; keep manual default (PORT-14)** |
| Global-install postinstall | absent [C] | guarded postinstall [C] | **DEFER (no global writes) (PORT-14)** |
| LICENSE file | absent (metadata MIT) [C] | ISC text [C] | **Rights review before copying (PORT-15)** |
| Docs suite + CONTRIBUTING/CODEOWNERS | 2 docs [C] | 11 docs + CONTRIBUTING/CODEOWNERS [C] | **Selectively adopt docs practice** |
| Retired-role roster | 5 sub-agents, gates forbid retired [C] | 9 active incl. retired roles [C] | **Reject donor roster** |
| MCP transport | removed; CLI-only [C] | donor has codegraph MCP wiring | **Preserve CLI-only; no MCP reintroduction** |

## 5. Findings register (severity + confidence)

Severity: **High / Med / Low**. Confidence tags as above. **[I]/[U]** items are not
reproduced runtime defects; only **[E]** is.

### 5.1 Target-side

| ID | Sev | Conf | Finding | Anchor | Remediation |
|---|---|---|---|---|---|
| T1 | Med | [C] | The orchestrator prompt says `arcs worktree validate` blocks `arcs done`, but `done` never calls it — policy text, not a runtime gate. | `src/cli/orchestrator-shared-blocks.ts` vs `src/cli/commands/done.ts` (imports `findWorktreeByPlan` only) | PORT-00b (decision) |
| T2 | Med | [C] | Sub-agent prompt blocks are duplicated across 5 static `.txt` with no SSOT; parity tests guard only the 3 orchestrator mirrors. | `opencode/arcs/prompts/*.txt`, `test/prompt-parity.test.ts`, `test/typed-agent-prompt-contract.test.ts` | **PORT-16** |
| T3 | Low | [C] | Checked-in `.pi/subagents.json` sets depth 2, `strictAgentFiles`/`scopeModels` false, unbounded turns; donor hardens these. **Actual runtime load/semantics are unverified** (config presence ≠ effect). | `.pi/subagents.json` (file present) | PORT-12 (opt-in, measured) |
| T4 | Low | [C] | Any ported prompt prose competes with the orchestrator prompt **budget**; `.txt` byte sizes are **not** a measured runtime char-budget breach. A current dirty-file measurement is needed before adding prose. | `test/orchestrate-prompt-baseline.test.ts`, `test/prompt-lean-budget.test.ts` (user edits) | PORT-16 (budget test) |
| T5 | Med | [C] | Containment is **lexical** in both readers (no `realpath`): they reject absolute paths and `..` traversal lexically but **do not** resolve symlink targets, so a symlink inside the workspace escapes. Anchor reader persists a **range**; snippet reader persists **content**; fixing `isInside` alone does not cover the anchor reader. | `src/utils/codegraph-knowledge.ts` (`isSafeRelativePath`), `src/utils/code-snippet.ts` (`isInside`, `readCodeChunk`) | **PORT-17** |
| T6 | Low–Med | [C] | Receipt `.json`+`.diff` written as two raw `writeFileSync` calls; pointer persisted **after** them → no fresh dangling pointer. `writeFilesTransaction` = best-effort rollback, **not** crash-atomic. Guarantee today = write-ordering. | `src/utils/report-store.ts`; pointer written later in `done.ts`; `src/utils/storage-utils.ts` | PORT-07 |
| T7 | Low | [C] | Web receipt route may return the full stored receipt including the capped diff by default, whereas the CLI gates diff behind `--diff`. | `src/web-server/routes/collections.ts` vs `src/cli/commands/report.ts` | PORT-07 (scope) |
| T8 | Low | [C] | `isChunkStale` is implemented and unit-tested but has no production caller, so **knowledge chunk** staleness is never surfaced. | `src/utils/code-snippet.ts`; callers only in `test/code-snippet.test.ts` | PORT-07 |
| T9 | Low | [C] | Code chunks persist raw file text (content) with range validation but no secret redaction; anchor reader persists only a range. | `src/utils/knowledge-store.ts` capture path; `src/utils/storage-utils.ts` sanitize | PORT-17 (policy) |
| T10 | Low | [U] | Allow-all claude-code/pi runner flags create a post-hoc-only review boundary; stated as a deliberate design (workspace snapshot + revert), not an oversight. Not an OS sandbox. | `src/web-server/run-driver.ts` (flags) | PORT-12 (opt-in) |
| T11 | Low | [U] | Cancel path persists a pid; after restart a recycled pid could be signalled. Design comment acknowledges reuse. | `src/web-server/routes/ask.ts`, `src/web-server/run-store.ts` | Deferred (see roadmap) |
| T12 | Low | [C] | Ask-path request body has no explicit size cap. Loopback-bounded. | `src/web-server/respond.ts` | PORT-13 |
| T13 | Low | [C] | `taskMetaSchema` under-declares `TaskMeta` (`planId`, `dependsOn`, `scope`, `acceptance`, `verify`, `skill`, `workMode`, `startHead`, `report`); no consumer on the read path today, but a future validated rebuild would strip fields. | `src/utils/json-schemas.ts` vs `src/utils/task-store.ts` | PORT-04 |
| T14 | **High** | **[E]** | **`--dry-run` is not inert on the target.** Isolated `ARCS_DATA_DIR`: `done --dry-run` moved a task `in_progress → done`; `remember --dry-run` created knowledge files. Target has no central dry-run refusal; donor refuses via `refusesDryRun`. `batch` static-confirmed. | executed; repro commands in [verification.md](./verification.md); `done.ts`/`remember.ts` (`mutation:true`, no guard) | **PORT-01** |
| T15 | Low | [E] | Public wrapper help is minimal/static (`scripts/arcs-cli.mjs --help`, exit 0); internal `dist/index.js --help`/`--version` exit 1; no `-h`/group help/`--version`. Donor help is registry-driven. | `scripts/arcs-cli.mjs`; `dist/index.js`; donor `help-generator.ts` | PORT-03 |

### 5.2 Donor-side (context for what **not** to import)

| ID | Sev | Conf | Finding | Anchor |
|---|---|---|---|---|
| D1 | Med | [C] | Donor stores write via plain `writeFile`; no atomic/sync primitives anywhere. | `src/utils/storage-utils.ts` (donor) |
| D2 | Low | [I] | **Legacy unguarded path:** donor `getGitLog --since` interpolates into `execSync` (reachable from `maintenance.ts`), and `getFilesChanged` interpolates `fromCommit` unquoted. The **newer ledger helpers** (`resolveCommit`/`isAncestor`/`listCommits`/`getCommitChanges`) **are** regex-guarded. Recommendation: **plumb argv-array subprocess calls from the target receipt engine** (`run-report.ts`) rather than importing shell interpolation even with guards. | donor `src/utils/git.ts` (`getGitLog`, `getFilesChanged` vs `SHA_PATTERN`/`REVISION_PATTERN` helpers); target `src/utils/run-report.ts` |
| D3 | Low | [I] | Donor hunk parsing keys on `+++ b/` without forcing diff prefixes; a user `diff.noprefix=true` could yield empty hunks. | donor `src/utils/git.ts` `parseHunks` |
| D4 | Low | [C] | Donor promotion claim is **read-check-append across two lock scopes** — **not atomic under concurrent duplicate calls, including async calls within one process**. The intended property is **replay convergence** (re-running `started` converges), **not** demonstrated exactly-once. | donor `src/workflow/artifact-service.ts` `prepare`, `src/workflow/journal.ts` `appendEntry` |
| D5 | Info | [C] | Donor `pairing-server` token compare is non-constant-time; studio/SSE pairing path is documented-removed and must not be ported. | donor `src/workflow/pairing-server.ts`, `web/src/sse-runner` |
| D6 | Info | [C] | License **declarations/text differ**: target metadata MIT with **no LICENSE file**; donor ISC text with a Traveloka copyright. The "relicensed" framing is **inferred**. Warrants rights/attribution review, **not** a proven violation. | donor `LICENSE`; target `package.json` |

## 6. Determinism: enforced vs. prompt-only

- **Deterministic in target:** `ARCS_GUARDED` write-gate choke point; worktree registry
  cross-checks; Pi permission ceiling encoded into deployed frontmatter tool allow-lists;
  `manifest.json` `task:deny` on sub-agents.
- **Absent dry-run determinism (target):** no `refusesDryRun` gate, so `--dry-run` is
  advisory rather than an enforced contract (**T14, [E]**).
- **Prompt-only (both):** "no implementation-source reads", "no nested delegation",
  "one owner per outcome", read-only role boundaries, and the return envelope. Contract
  tests assert **substrings**, so they cannot detect an agent that ignores them.
- **Deterministic in donor where target is prompt-only:** `strictAgentFiles`,
  `scopeModels`, `fallbackSubagent: none`, `maxSubagentDepth`, and real code paths for
  worktree cleanup / shutdown fencing. **Caveat:** these fixes are in a *vendored*
  runtime; whether the target's installed upstream is affected is **unverified**.
- The two enforcement styles **compose rather than substitute**: target is stronger
  CLI-side, donor stronger runtime-side.

## 7. Observed target test ledger (with timing/snapshot caveats)

The gate runs happened at different times against different dirty states — they must be
read separately. Durable results are in [verification.md](./verification.md).

| Gate | When | Worktree state | Result |
|---|---|---|---|
| `npm test` (`vitest run`) | ~01:12–01:13 UTC | **~10 dirty files** | 115 files passed; 1668 passed, 1 skipped; 63.93s |
| `npm run typecheck` (`tsc --noEmit`) | ~01:12–01:13 UTC | **~10 dirty files** | exit 0 |
| `npm run lint` (`biome check src/ test/ web/`) | ~01:12–01:13 UTC | **~10 dirty files** | 295 files checked, no fixes |
| `node scripts/lint-bundle.mjs` | later (~01:18 UTC) | later state | exit 0, `{errors:0,warnings:0}` — **existing bundle only, no rebuild** |
| `npm --workspace @arcs/web run typecheck` | later (~01:18 UTC) | later state | exit 0 |
| Donor gates | — | donor | **not run** (no `node_modules`/`dist`) |

**The initial test/lint/typecheck runs were not re-run after later edits and do not
validate the final 23-file state.** Not run at all: donor suite; `build`/`build:web`/
prepack (so bundle lint ran on the **existing** `opencode/arcs/`); CI/release workflows;
Node-20 floor; live HTTP probes. These are **not** claimed to pass.

## 8. Schema/ID migration summary

- New donor `docs/` collection: additive, rebuild-on-read index → no data migration (Low).
- `taskMetaSchema` completion: optional JSON-additive → Low (schema-only).
- Knowledge `stub`/`commits`: optional metadata → Low.
- Graph `doc` node/edges: no persisted migration → Low.
- Config migration-before-validate: needed for donor-style upgrade survivability (Med).
- FileRef shape: donor's is **narrower** (no `startLine/endLine`) than target's — must use
  the target shape before any donor doc `sourceFiles` code lands, or ranges vanish (Med).
- Lock-scheme divergence: target locks `plans/.store`; donor stores lock `index.json.lock`.
  Ported donor stores must be re-homed onto the target lock scheme (Med).

## 9. Open decisions (need a choice, not an unanswered fact)

1. **Worktree gate (T1):** enforce `worktree validate` in `done`, or keep it as
   fail-soft policy with corrected wording? (PORT-00b)
2. **Receipt durability (T6):** accept write-ordering + diagnostics, or pursue a
   generation-based crash-atomic protocol (larger)? (PORT-07)
3. **Path containment (T5):** adopt a realpath policy — and which legitimate symlinked
   workspace layouts must it preserve? (PORT-17)
4. **Pi version:** which installed Pi version does the target track, and does the donor
   vendored runtime load on it? (PORT-12 defer decision)
5. **`codeChunks` semantics:** authoritative evidence or hint? (`index-builder` weights
   it 0.5×summary.)
6. **Graph provenance:** adopt doc edges, and ledger edges only once PORT-08 exists?
7. **Rights outcome:** attribution/rights decision for any copied donor file (PORT-15).
