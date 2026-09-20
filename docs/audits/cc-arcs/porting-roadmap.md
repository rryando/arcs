# cc-arcs → arcs porting roadmap (DRAFT — not approved)

**Status: DRAFT / pending approval.** This is a decision surface, not an execution plan.
**No ARCS tasks, plans, diagrams, or worktrees exist for any item.** All effort figures
are **estimates** (S ≈ ≤1 day, M ≈ 1–3 days, L ≈ >3 days of focused work), not
commitments. All paths are **design estimates** of where work would likely land. Finding
IDs (T…/D…) refer to [technical-report.md §5](./technical-report.md#5-findings-register-severity--confidence).

**Porting mode:** selective reimplementation. The repos share **zero reachable commit
IDs** (content-similar blobs only; the `3.9.x` fork point is a content-similarity
estimate). Cherry-pick would require importing donor objects; no patch application was
tested. Do **not** apply donor patches wholesale.

**Verification convention:** each item lists scoped commands to run in addition to the
[integration hard gates](#integration-hard-gates-all-items). Test paths labelled **NEW**
do not exist yet and would be created by that item; other paths already exist.

## Dependency graph (matches every item's `Depends on`)

```
PORT-00  Freeze invariants + test contract (P0)            [depends: none]
PORT-15  Rights/attribution pre-copy gate (P0)             [depends: none; gates donor-file adaptation]

PORT-00 ─┬─ PORT-00b worktree policy decision              [depends: PORT-00]
         ├─ PORT-01  central dry-run guard                 [depends: PORT-00]
         ├─ PORT-02  parser hardening ── PORT-03 help      [PORT-02: PORT-00; PORT-03: PORT-02]
         ├─ PORT-04  task schema                           [depends: PORT-00]
         ├─ PORT-05  config tryReadConfig                  [depends: PORT-00]
         ├─ PORT-07  receipt ordering/staleness ── PORT-08 ledger   [PORT-07: PORT-00; PORT-08: PORT-07]
         ├─ PORT-11  cross-project listing helper (optional)        [depends: PORT-00]
         ├─ PORT-12  runner permission modes (opt-in)      [depends: PORT-00]
         ├─ PORT-13  request cap + mermaid hardening       [depends: PORT-00]
         ├─ PORT-14  release safety gates                  [depends: PORT-00]
         ├─ PORT-16  sub-agent prompt SSOT                 [depends: PORT-00]
         ├─ PORT-17  realpath/path-containment policy      [depends: PORT-00]
         ├─ PORT-18  filesystem-declared skills            [depends: PORT-00]
         └─ PORT-19  Pi deploy ownership preflight+revert  [depends: PORT-00]

PORT-04 ─── PORT-06 task brief                             [depends: PORT-04]
PORT-04, PORT-07 ─── PORT-09 opt-in docs ── PORT-10 graph edges
                                                           [PORT-09: PORT-04, PORT-07;
                                                            PORT-10(a): PORT-09; PORT-10(b): PORT-08]
PORT-07 ─── PORT-08 ledger ─── PORT-10(b) task_changed_file edge   [PORT-08: PORT-07]
```

## P0 — Preserve invariants, and gate rights before copying

### PORT-00 — Freeze the invariant + test contract
- **Outcome:** a written invariants baseline every later port must not break:
  `ARCS_GUARDED` write-gate + `--token`; plan-scoped worktree registry; receipt + code-chunk
  evidence capture; richer zod schemas; CLI-only + multi-adapter (opencode/claude-code/pi);
  dependency-honest DAG; existing `doc`/`proposal-doc` commands and accepted proposals.
- **Likely target paths:** none changed (documentation only).
- **Depends on:** none.
- **Verification:** the gate results in [verification.md §2](./verification.md#2-target-quality-gates-executed-read-only). Baseline to beat (initial snapshot): `npx vitest run` 115 files / 1668+1skip; `npm run typecheck`; `npm run lint`; `npm run build:opencode-bundle` + `node scripts/lint-bundle.mjs`; `npm --workspace @arcs/web run typecheck`.
- **Rollback:** n/a.
- **Effort:** **S (estimate)**.
- **Decision gate:** confirm the invariant list is complete before P1.

### PORT-15 — Rights/attribution pre-copy gate (D6)
- **Outcome:** a documented rights decision **before any donor file text is copied or
  adapted**. Target metadata is MIT with **no LICENSE file**; donor shows **different**
  license declarations (ISC text, Traveloka copyright). Add a LICENSE as advised and
  preserve notices where required. No infringement conclusion is drawn.
- **Likely target paths:** new `LICENSE`, `package.json` `license` field.
- **Donor reference:** donor `LICENSE` (ISC, © 2026 Traveloka).
- **Depends on:** none. **Gates** every item that adapts donor file text
  (at least PORT-04, PORT-06, PORT-08, PORT-09, PORT-12, PORT-13, PORT-16).
- **Verification:** documented rights decision recorded in the repo; `LICENSE` present
  and consistent with metadata; `git diff --check` clean.
- **Rollback:** revert `LICENSE`/metadata.
- **Effort:** **S (estimate)** plus external review time.
- **Decision gate:** **user/legal must decide; condition on pre-copy use, not at the end.**

### PORT-00b — Resolve the worktree-validate policy question (T1)
- **Outcome:** an explicit decision: (a) keep "`worktree validate` must pass" as
  **fail-soft orchestrator policy** with corrected wording, or (b) add a real `done` gate.
  Do **not** unilaterally change the current fail-soft receipt policy.
- **Likely target paths:** `src/cli/orchestrator-shared-blocks.ts` (wording) **or**
  `src/cli/commands/done.ts` (gate).
- **Donor reference:** none (donor has no equivalent gate).
- **Depends on:** PORT-00.
- **Verification:** (a) `npx vitest run test/orchestrate-prompt-policy.test.ts` asserts the
  new wording; (b) `npx vitest run test/worktree-commands-e2e.test.ts test/worktree.test.ts`
  plus **NEW** `test/done-worktree-gate.test.ts` cover the typed violation and the allow path.
- **Rollback:** revert the wording / one gate.
- **Effort:** **S (estimate)**.
- **Decision gate:** **user must choose (a) vs (b).**

## P1 — Parser, central dry-run, schema/SSOT/path parity

### PORT-01 — Central dry-run guard (T14, [E])
- **Outcome:** `--dry-run` either honors intent or is refused centrally with a typed error;
  **never** executes a mutation. Keep `--token`/`ARCS_GUARDED` untouched. Adopt donor
  `refusesDryRun` semantics; declare `supportsDryRun` truthfully.
- **Likely target paths:** `src/cli/command-registry.ts`, `src/cli/index.ts`,
  `src/cli/commands/{batch,done,remember,diagram,proposal}.ts`.
- **Donor reference:** `src/cli/command-registry.ts` (`refusesDryRun`, `DRY_RUN_UNSUPPORTED`),
  `src/cli/index.ts` (refusal gate).
- **Depends on:** PORT-00.
- **Verification:** **NEW** `test/dry-run-guard.test.ts`; `npx vitest run test/dry-run-guard.test.ts test/batch-knowledge-create.test.ts test/write-gate-enforcement.test.ts test/write-gate-opt-in.test.ts`; plus an isolated `ARCS_DATA_DIR` check that `done … --dry-run` leaves status unchanged and `remember … --dry-run` creates no files.
- **Rollback:** revert the predicate (behavior returns to today's defective state).
- **Effort:** **S–M (estimate)**.
- **Decision gate:** confirm `--token`/guarded mode must remain (yes per P0).

### PORT-02 — Parser hardening (keep `--token`)
- **Outcome:** add `-h`, kebab-case param aliases (`--plan-id` → `planId`), and a bare-value
  guard ("requires a value"), **while retaining the target `--token` parse**.
- **Likely target paths:** `src/cli/arg-parser.ts`.
- **Donor reference:** `src/cli/arg-parser.ts` (`resolveParamName`, bare-value guard).
- **Depends on:** PORT-00.
- **Verification:** `npx vitest run test/arg-parser.test.ts test/cli-router.test.ts`; plus new
  cases (add to `test/arg-parser.test.ts`, labelled NEW additions) for `--plan-id` alias,
  missing-value error, and `--token=<v>`.
- **Rollback:** revert `arg-parser.ts`.
- **Effort:** **S (estimate)**.
- **Decision gate:** none beyond P0.

### PORT-03 — Registry-driven help/version + unknown-command suggestion (T15)
- **Outcome:** align public wrapper and internal entry: general + group help, `--version`/`-v`,
  and a "did you mean" suggestion, generated from the registry so text cannot drift.
  **`src/cli/help-generator.ts` already exists — extend it**, do not create a new module.
- **Likely target paths:** `src/cli/help-generator.ts` (extend), `scripts/arcs-cli.mjs`,
  `src/cli/index.ts`.
- **Donor reference:** donor `help-generator.ts` (`generateGeneralHelp`/`generateGroupHelp`),
  `src/cli/index.ts`.
- **Depends on:** PORT-02.
- **Verification:** `npx vitest run test/help-generator.test.ts test/arcs-cli-script.test.ts test/cli-envelope.test.ts`; manual: `node scripts/arcs-cli.mjs --help`, `--version`, `arcs <group> --help`, unknown command — all exit 0 and agree between wrapper and `dist/index.js`.
- **Rollback:** revert wrapper/index/help-generator.
- **Effort:** **S–M (estimate)**.
- **Decision gate:** none.

### PORT-04 — Complete `taskMetaSchema` (T13)
- **Outcome:** schema declares the full **current** `TaskMeta` interface; add a round-trip
  test asserting schema keys == interface keys. **Do not add future fields** (`docRefs`
  arrives with PORT-09; `baselineCommit` is not adopted) — **reuse the target `startHead`**
  rather than introducing a duplicate baseline field.
- **Likely target paths:** `src/utils/json-schemas.ts`, `src/utils/task-store.ts`.
- **Donor reference:** donor `json-schemas.ts` + `test/task-meta-round-trip.test.ts`
  (also incomplete — target must be a **union superset of current fields only**).
- **Depends on:** PORT-00.
- **Verification:** **NEW** `test/task-meta-round-trip.test.ts`; `npx vitest run test/task-meta-round-trip.test.ts`.
- **Rollback:** revert schema + test.
- **Effort:** **S (estimate)**.
- **Decision gate:** none.

### PORT-05 — `tryReadConfig` + migration-before-validate
- **Outcome:** config read returns `{ok:false, issues}` instead of `process.exit(1)`;
  retired-runtime migration runs before validation so upgrades survive.
- **Likely target paths:** `src/cli/config.ts`.
- **Donor reference:** donor `config.ts` (`tryReadConfig`, `migrateLegacyConfig`),
  `test/config-round-trip.test.ts`.
- **Depends on:** PORT-00.
- **Verification:** **NEW** `test/config-round-trip.test.ts` (adapted); `npx vitest run test/config-round-trip.test.ts test/model-config.test.ts`.
- **Rollback:** revert config read path.
- **Effort:** **M (estimate)**.
- **Decision gate:** confirm which legacy fields (if any) exist in target installs.

### PORT-16 — Sub-agent prompt SSOT (T2, T4)
- **Outcome:** replace the 5 duplicated static sub-agent `.txt` prompt blocks with a shared
  fragments module and per-agent generation, extending the **existing**
  `scripts/build-opencode-bundle.mjs`. Preserve **all live user edits** to prompts/skills
  and the orchestrator composition. Maintain cross-adapter parity (opencode/claude-code/pi)
  and keep typed-contract + budget tests green. No role expansion.
- **Likely target paths:** `src/cli/orchestrator-shared-blocks.ts` (extract fragments),
  `opencode/arcs/prompts/*.txt` (now generated), `scripts/build-opencode-bundle.mjs` (extend),
  `opencode/arcs/manifest.json`.
- **Donor reference:** `src/cli/prompts/fragments.ts`, donor `scripts/build-opencode-bundle.mjs`.
- **Depends on:** PORT-00.
- **Verification:** `npx vitest run test/typed-agent-prompt-contract.test.ts test/prompt-parity.test.ts test/orchestrate-prompt-baseline.test.ts test/prompt-lean-budget.test.ts test/skill-prompt-contract.test.ts test/opencode-agent-order.test.ts`; then `npm run build:opencode-bundle && node scripts/lint-bundle.mjs`.
- **Rollback:** revert fragments extraction; regenerate `.txt` from prior source (git).
- **Effort:** **M (estimate)**.
- **Decision gate:** confirm the 5-prompt roster and user-edited wording must be preserved verbatim.

### PORT-17 — Realpath/path-containment policy (T5, T9)
- **Outcome:** adopt an explicit path-containment policy (realpath or equivalent) for
  **both** the anchor reader and the code-snippet reader so a symlink inside the workspace
  cannot escape to arbitrary reads; define whether legitimate symlinked workspace layouts
  must remain allowed. Land **before** any new evidence-capture work (P2). Optionally
  document the code-chunk redaction posture (T9).
- **Likely target paths:** `src/utils/code-snippet.ts` (`isInside`), `src/utils/codegraph-knowledge.ts`
  (`isSafeRelativePath`).
- **Donor reference:** none (donor does not fix this; use the target receipt engine's argv discipline).
- **Depends on:** PORT-00.
- **Verification:** **NEW** `test/path-containment.test.ts` (symlink escape, `..`, absolute,
  NUL, legitimate symlink allow case); `npx vitest run test/path-containment.test.ts test/code-snippet.test.ts test/codegraph-ingestion.test.ts`.
- **Rollback:** revert containment policy.
- **Effort:** **S–M (estimate)**.
- **Decision gate:** **user must decide** symlink policy (deny all vs allow registered roots).

### PORT-18 — Filesystem-declared skills (bundle surface)
- **Donor commit:** `264150a` (#52). Only the **`skills` map** of `bundle-runtime.json` moved
  to a filesystem walk (`src/utils/bundle-skills.ts`); `agents`/`plugin`/`preservedFiles`/
  `excludePatterns` stay hand-declared (the donor did **not** retire `bundle-runtime.json`).
- **Outcome:** replace ARCS's ~62-line hand `skills` map in `opencode/arcs/bundle-runtime.json`
  with a filesystem walk, **keeping `preservedFiles`/`agents`/`plugin`** and promoting
  `excludePatterns` to an active filter with a glob converter that **throws on unsupported
  shapes** (never matches nothing). **Retain the lint `{errors:0,warnings:0}` 0/0 gate** as the
  stray-file guard — a walk-driven lint alone would auto-ship any file dropped into a skill dir.
- **Likely target paths:** `opencode/arcs/bundle-runtime.json`, `scripts/build-opencode-bundle.mjs`,
  `scripts/lint-bundle.mjs` (Checks 1/2/3).
- **Donor reference:** donor `src/utils/bundle-skills.ts`, `scripts/build-opencode-bundle.mjs`.
- **Depends on:** PORT-00.
- **Verification:** `npm run build:opencode-bundle && node scripts/lint-bundle.mjs` reports
  `{errors:0,warnings:0}`; `npx vitest run test/opencode-bundle-build.test.ts test/bundle-lint.test.ts test/opencode-bundle-pruning.test.ts test/opencode-bundle-smoke.test.ts`.
- **Rollback:** restore the hand `skills` map (git).
- **Effort:** **M (estimate)**.
- **Decision gate:** confirm the walk does not weaken the stray-file defense (excludePatterns retained).

### PORT-19 — Pi deploy ownership preflight + tracked settings revert
- **Donor commit:** `d0ba884` (#82). ARCS's Pi deploy already skips a user-modified extension
  (`extensionSkipped: "user-modified"`) but has **no** preflight-parse-before-write and **no**
  tracked revert for its `settings.json` model merge.
- **Outcome:** (a) parse **all** shared JSON before **any** write and refuse/with-report on a
  conflict; (b) record and revert exactly the `settings.json` model entries ARCS merged
  (donor `mergeFragmentTracked`/`revertMergedEntries`, `deploy-pi-bundle.mjs:405-441`);
  optionally a `preflightPiPackageRoot`-style "refuse to write unless we can prove ownership"
  (`:379-393`). **Do not** port the extensions catalogue itself (see
  [deep-dive-ledger-graph-build-commits.md §C.3](./deep-dive-ledger-graph-build-commits.md#c3-pi-extensions-catalogue-7782-c)).
- **Likely target paths:** `scripts/deploy-pi-bundle.mjs`.
- **Donor reference:** donor `scripts/deploy-pi-bundle.mjs` (`:355-361`, `:379-393`, `:405-441`).
- **Depends on:** PORT-00.
- **Verification:** `DEPLOY_DRY_RUN=false` against a temp `DEPLOY_CONFIG_ROOT`; `npx vitest run test/deploy-pi-bundle.test.ts`.
- **Rollback:** revert the deploy script.
- **Effort:** **S–M (estimate)**.
- **Decision gate:** confirm only-record-and-revert (no new catalogue).

## P2 — Task brief, evidence ordering, additive changes ledger

### PORT-06 — `task brief` dispatch contract
- **Outcome:** render GOAL/SCOPE/CONTEXT/VERIFY/STOP from existing task metadata, retrieval
  results, receipts, and knowledge — **without** importing the donor docs engine. Add the
  command declaration to the **existing** `src/cli/commands/task.ts` (or a new command file
  imported via `src/cli/commands/index.ts`); do **not** invent manual registry registration.
- **[X] The donor CONTEXT block IS the docs engine — this is a structural, not cosmetic,
  dependency.** The donor `briefDoc()` reads `task.docRefs[0].revisionHash`, calls
  `readPinnedRevision`, and embeds `excerptSections` from the pinned doc into CONTEXT
  (donor `src/cli/task-brief.ts` renderDispatch). Therefore an ARCS `task brief` **cannot be a
  like-for-like port until PORT-09**: the ARCS version must assemble CONTEXT from task
  metadata + `retrieveForTask` knowledge (gotchas first) + predecessors' ledger commits, and
  **drop** the pinned-section source. This is a material omission in the earlier roadmap text.
- **[X] `brief` NAMESPACE COLLISION (must not shadow).** ARCS already ships a **project-level**
  `brief` command (`src/cli/commands/brief.ts` → `renderBrief`, plus `src/cli/brief-renderer.ts`,
  exposed as T0 `brief` and `next`). The donor's `task brief` / `next --brief` is a
  **different, task-scoped** brief. The new command must be namespaced under `task` (e.g.
  `arcs task brief <slug> <id>`) and must **not** shadow or repurpose the existing
  project-level `brief`/`next` surfaces.
- **Likely target paths:** `src/cli/commands/task.ts` (or new `src/cli/commands/task-brief.ts`
  imported via `src/cli/commands/index.ts`), reusing `src/cli/brief-renderer.ts` patterns.
- **Donor reference:** `src/cli/task-brief.ts` (GOAL/SCOPE/VERIFY/STOP are portable;
  CONTEXT's `briefDoc`/pinned-section path is PORT-09-only).
- **Depends on:** PORT-04.
- **Verification:** **NEW** `test/task-brief.test.ts` (adapt donor `test/task-brief.test.ts`);
  `npx vitest run test/task-brief.test.ts test/brief-renderer.test.ts`; the existing
  project-level `brief`/`next` tests stay green; output is byte-stable for a fixed task.
- **Rollback:** remove the command declaration.
- **Effort:** **M (estimate)**.
- **Decision gate:** confirm no docs-engine dependency is acceptable, and that the new
  task-scoped brief does **not** shadow the project-level `brief`/`next`.

### PORT-07 — Receipt write-ordering/diagnostics + knowledge-chunk staleness (T6, T8)
- **Outcome:** make the receipt write path explicit and scoped: **atomic per-file
  (temp+rename)**, **serialized publication** of the `.json`/`.diff` pair, **pointer-last**,
  fail-soft completion diagnostics; injected synchronous-error rollback tests. Crash /
  mixed-generation recovery detection is a **separate, optional** phase — do **not** promise
  an "old-or-new pair" without a generation-based protocol. Surface **knowledge-entry**
  chunk staleness (T8 lives on knowledge entries, not done tasks).
- **Likely target paths:** `src/utils/report-store.ts`, `src/utils/code-snippet.ts`,
  `src/cli/commands/utility.ts` (validate checks).
- **Donor reference:** donor `validate --checks=changes,citations`
  (`src/cli/commands/utility.ts`), `dangling_knowledge_commit`.
- **Depends on:** PORT-00.
- **Verification:** **NEW** `test/receipt-durability.test.ts` (scoped atomicity/ordering +
  injected synchronous error); `npx vitest run test/receipt-durability.test.ts test/run-report.test.ts test/code-snippet.test.ts test/plan-receipt.test.ts test/report-command.test.ts`; `arcs validate arcs` shows a chunk-staleness issue for a drifted entry.
- **Rollback:** revert report-store/code-snippet wiring.
- **Effort:** **M (estimate)**.
- **Decision gate:** whether to pursue the optional generation-based crash-atomic protocol (larger).

### PORT-08 — Additive lightweight changes ledger indexed to receipts
- **Donor commit:** `f3861a3` (#83) — `src/workflow/change-ledger.ts` (305 L) + `changes.ts`
  +372, `utility.ts` +141, `task.ts` +87, `status.ts` +31, graph ±57. The **same commit**
  that adds `task_cites_doc`/`task_changed_file` also adds the ledger they read. See
  [deep-dive-ledger-graph-build-commits.md Part A](./deep-dive-ledger-graph-build-commits.md#part-a--ledgers-f3861a3-83).
- **Outcome:** append-only, lock-guarded JSONL ledger storing **diffstat + hunk headers
  only** — plus a commit's sha/subject/author/authoredAt/patchId (see
  [deep-dive §B.1](./deep-dive-doc-to-plan-and-diff-tools.md#b1-inventory-donor)).
  **Only the ledger excludes patch text; receipts retain their current capped
  snapshot+diffs.** Committed change patches re-render from git **when reachable**;
  dangling SHAs are **reported** (`reachable:false`), **not resolved** — `patchId` is
  **advisory only, recorded but never used for matching** (dedup is by `(taskId,sha)`). Add
  `plan changes` and `next --brief` integration.
  Use **argv subprocess** calls (no copied shell-interpolation helpers) and **pin
  `-c diff.noprefix=false -c diff.mnemonicPrefix=false`** plus the target
  `code-snippet.ts` quote normalization (`normalizeDiffPath`) so `+++ b/<path>` hunk headers
  cannot silently vanish. Idempotency/
  attribution must **avoid duplicate task credit**: index using the existing `startHead` +
  registered plan-worktree baseline. **[X] Never introduce `baselineCommit`** — the donor's
  field duplicates the target `startHead`, and two baselines can diverge; the ledger is keyed
  off `startHead` only (see [deep-dive §A.7](./deep-dive-ledger-graph-build-commits.md#a7-hard-rules-adopted-invariants)).
  Knowledge `stub`/`commits` are **optional metadata additions only**, preserving `--code`,
  `--workMode`, `--no-report`.
- **[X] D7 fix — read the ledger INSIDE the lock.** The donor `recordCommits` reads via
  `readChanges` **outside** the append lock (`withLock` wraps only `appendChange`), so
  concurrent writers duplicate `(taskId,sha)` lines (reads dedup, but the log grows). The port
  must **re-read inside the lock** so duplicate `(taskId,sha)` writes are impossible under
  concurrency.
- **Risks (from [deep-dive §B.5](./deep-dive-doc-to-plan-and-diff-tools.md#b5-correctness-risks)):**
  `recordCommits` reads the ledger **outside** the append lock, so concurrent writers can
  duplicate `(taskId,sha)` lines (reads dedup, but the log grows); `getWorktreeDiffstat`
  slices `??` names, so a dirty **untracked directory** collapses to one entry and a tree
  dirty only via mode/submodule change returns **null** (enumerate with
  `ls-files --others --exclude-standard`); a `pending` entry is superseded by **any** later
  commit even if that commit does not cover the uncommitted work.
- **Likely target paths:** new `src/utils/change-ledger.ts`; wire into
  `src/utils/run-report.ts`/`report-store.ts`; new `src/cli/commands/changes.ts` (command
  declaration via `src/cli/commands/index.ts`); `src/cli/commands/plan.ts` (`plan changes`);
  `src/cli/commands/next.ts` (`--brief`).
- **Donor reference:** `src/workflow/change-ledger.ts`, `src/cli/commands/changes.ts`,
  donor `src/utils/git.ts` helper semantics (re-implemented with argv arrays, not copied).
- **Depends on:** PORT-07.
- **Verification:** **NEW** `test/change-ledger.test.ts` (append/lock/dup-credit cases) and
  **NEW** `test/git.test.ts` (argv/no-shell + `noprefix` pin);
  `npx vitest run test/change-ledger.test.ts test/git.test.ts test/run-report.test.ts`; acceptance: `arcs task changes <slug> <id> --patch` re-renders committed patches from git and persists no patch body in the ledger, while the receipt retains its capped diff; a tree dirty via an untracked **directory** yields a `pending` entry with untracked names (not one collapsed entry); `plan changes` rolls up; `next --brief` includes the ledger.
- **Correction ([X]):** the earlier acceptance clause “a dirty read-only change shows the
  receipt snapshot” was **wrong** — that view **does not exist in the donor** (`pending`
  stores diffstat + untracked names and `task changes` never joins a receipt). Treat any
  receipt-joined ledger view as **new work, not a port**.
- **Rollback:** disable the new ledger reads/writes and archive the ledger file — **never
  delete a user's ledger**; existing receipt refs remain intact.
- **Effort:** **M–L (estimate)**.
- **Decision gate:** confirm the ledger is **additive** (receipts remain the heavy store) and that duplicate-credit rules are acceptable.

## P3 — Opt-in generalized docs, citations, graph edges

### PORT-09 — Opt-in generalized docs (tech-doc/design-doc) + `doc promote`
- **Outcome:** donor doc subsystem ported as an **opt-in** capability, **decomposed into a
  bounded promote core**, not one "L blob" (see
  [deep-dive §A.11](./deep-dive-doc-to-plan-and-diff-tools.md#a11-minimal-viable-promote-slice-and-the-gap-vs-arcs)).
  **Portable slice (estimate ≈2 700 LOC):** `doc-store.ts` (`DocMeta` +
  `planIds`/`revisionHash`/`supersedes`, CRUD, `recordDocPromotion`); the doc slice of
  `storage-utils.ts` (kinds/statuses/transitions/`DOC_PROMOTABLE_STATUS`/`sanitizeFileRefs`);
  `doc-templates.ts` + `doc-ranges.ts` (template contract, `parseTaskBreakdown`,
  `excerptSections`); `artifact-service.ts`
  (`snapshotTdd`/`promote`/`readPinnedRevision`/`validatePromoteTasks`/`performWrites`);
  `promoted-plan-body.ts`; the **promotion** half of `journal.ts`; `docRefs` on task-store; a
  `doc` command group; advisory `doc-health`/`citations` checks; the donor error factories.
  Lifecycle enums, pinned revisions, integrity-gated writes.
  **EXCLUDED (cleanly separable):** donor `src/workflow/doc-turn/**` (**3 664 LOC, 12 files**),
  `web/src/console/authoring/**` (7 files), and the **168-file** `web/src/console`.
  New dirs `docs/` + `workflow/tdd/` are **additive** (no data migration).
  **Preserve the existing target `doc update` and
  `proposal-doc` commands and any accepted proposal files** — the new commands are additive
  and must not shadow or migrate them. Migration is additive with opt-in adapters; **do not
  silently move old proposals**. Route writes through the target `writeFilesTransaction` +
  `.store` lock; use the **wider** target `FileRef` (`startLine/endLine`). `writeFilesTransaction`
  alone does **not** supply crash-atomicity or concurrency safety, so add explicit
  pinned-revision and claim/recovery handling.
- **Risks:** (a) **revision-store growth — no GC**: every body change adds an immutable
  `workflow/tdd/<docId>/<hash>.md`, unbounded (no collector in the source read);
  (b) **`snapshotTdd` also writes a `decision` knowledge entry** (donor
  `src/workflow/artifact-service.ts:107-144`) — a **decision-knowledge coupling** ARCS may
  drop; (c) concurrency — the non-atomic claim is only **convergent**, not exactly-once
  (audit D4); (d) file-ref lexical containment (no `realpath`) carries over if donor doc
  code is reused.
- **Likely target paths:** new `src/utils/doc-store.ts`, `src/utils/doc-ranges.ts`,
  `src/utils/doc-templates.ts`; new `src/cli/commands/doc.ts` imported via
  `src/cli/commands/index.ts`; storage helpers in `src/utils/storage-utils.ts`; schemas in
  `src/utils/json-schemas.ts`.
- **Donor reference:** `src/utils/{doc-store,doc-ranges,doc-templates}.ts`,
  `src/workflow/{artifact-service,promoted-plan-body,journal}.ts`,
  `src/cli/commands/doc.ts`, donor doc/lifecycle enums.
- **Depends on:** PORT-04, PORT-07.
- **Verification:** **NEW** `test/doc-store.test.ts`, `test/doc-ranges.test.ts`,
  `test/doc-templates.test.ts`, `test/doc-commands.test.ts` (adapted); plus preserved
  `npx vitest run test/proposal-cli.test.ts`; acceptance: legal transitions only; a pinned
  **missing** doc/section is **refused before any write**; an idempotent retry creates **no
  duplicate task IDs**; concurrent same-key promote is claim-protected and recoverable
  (**convergence**, not exactly-once external side effects); `doc create → update-body → get`
  round-trips `sourceFiles` `startLine/endLine`.
- **Rollback:** feature-flag off the **new opt-in** commands; **keep** `doc update`,
  `proposal-doc`, and accepted proposals untouched. Simple delete is protected/allowed;
  **destructive cascades require explicit approval**.
- **Effort:** **L (estimate)** for the full opt-in docs surface; the **promote core alone is
  M (estimate)** (≈2 700 LOC).
- **Decision gates (explicit):** (1) **`doc` namespace ALIAS COLLISION** — ARCS already
  defines `doc update` as an alias for `project update-doc` (target
  `src/cli/commands/dependency.ts:190`); porting a `doc` group **shadows that alias** — pick a
  distinct group name (e.g. `tech-doc`) or reconcile. (2) **two `promote` verbs** — ARCS
  `proposal-doc promote` (rename-only, `src/cli/commands/proposal-doc.ts:407-476`) vs donor
  `doc promote` (plan+tasks); confusing if both ship. (3) does `tech-doc`/`design-doc`
  **supersede** or **coexist** with `proposal-doc`? (4) user must approve adding an opt-in
  docs engine (largest scope).

### PORT-10 — Graph doc edges (split: docs-derived vs ledger-derived) [X]
- **Outcome:** two independent additions, previously conflated into one item:
  - **(a) Docs-derived — PORT-09-gated.** Add the `doc` node type + `doc_spawns_plan` (0.8)/
    `plan_derives_from_doc` (1.0)/`task_cites_doc` (1.0) edges and cache invalidation on
    `docs/index.json` (`sourceHashes.docs`, added only when the file exists). Source:
    `5124228` (#45) for the `doc` node + doc↔plan edges; `f3861a3` (#83) for `task_cites_doc`
    (from `task.docRefs`). **Needs PORT-09.**
  - **(b) Ledger-derived — PORT-08-gated (NOT PORT-09).** Add the `task_changed_file` (0.85)
    edge + an `EdgeRelation` union member + `sourceHashes.changes` (added **only when the
    ledger file exists**; otherwise `graph-cache.ts:isValid` treats a missing tracked file as
    stale and rebuilds every read). Derivation: group `readChanges(projectDir)` into
    `changedFilesByTask`, **skip paths already declared in `task.sourceFiles`**, and reuse
    `registerFileRef` so the existing `shares_source_file` pairing picks them up (donor
    `graph-builder.ts:187-222`). **Needs PORT-08 only** — once the ledger exists the edge is
    neither speculative nor docs-gated. The earlier "do not add a speculative unused
    `task_changed_file` union member" instruction is **superseded [X]**: add it with the
    ledger (PORT-08), independently of PORT-09.
- **Likely target paths:** `src/retrieval/graph-types.ts` (`NodeType`, `EdgeRelation`,
  `EDGE_WEIGHTS`), `src/retrieval/graph-builder.ts` (`sourceHashes`, derivation block).
- **Donor reference:** donor `retrieval/graph-types.ts`, `graph-builder.ts`.
- **Depends on:** (a) PORT-09; (b) PORT-08.
- **Verification:** `npx vitest run test/graph-builder.test.ts test/graph-types.test.ts test/graph-cache.test.ts`
  plus added cases; acceptance: (a) rebuild emits `doc:*` nodes and doc edges and the cache
  invalidates when `docs/index.json` changes; (b) a recorded ledger commit emits a
  `task_changed_file` edge and `shares_source_file` then pairs it, and the cache invalidates
  when the ledger file changes but not when it is absent.
- **Rollback:** revert graph builder/types.
- **Decision gate:** confirm doc provenance edges are wanted (open decision); (b) is safe to
  land independently with the ledger.

### PORT-11 — Optional cross-project knowledge listing helper
- **Outcome:** target **already has** cross-project knowledge search
  (`src/retrieval/cross-project-search.ts`, `test/cross-project-search.test.ts`). The donor
  only adds a listing helper (`listKnowledgeAcrossProjects`/`CrossProjectKnowledgeEntry`);
  port it **only if demand exists**, and independent of the docs engine.
- **Likely target paths:** `src/cli/commands/knowledge-search.ts`, helper near
  `src/retrieval/cross-project-search.ts`.
- **Donor reference:** donor `listKnowledgeAcrossProjects` + `CrossProjectKnowledgeEntry`.
- **Depends on:** PORT-00.
- **Verification:** `npx vitest run test/cross-project-search.test.ts` plus added listing cases.
- **Rollback:** remove the helper.
- **Effort:** **S (estimate)**.
- **Decision gate:** optional; confirm demand.

## P4 — Selective security caps and release safety

### PORT-12 — Opt-in least-privilege runner modes (T3, T10)
- **Outcome:** add an opt-in "read-only" runner mode mapping donor allow/disallow flags into
  the target adapters; **default remains current allow-all + post-hoc diff review**. Tool
  flags are **not** an OS sandbox. Any subagent tuning is **opt-in with measured turn
  budgets** and installed-version compatibility — not a blind copy of `defaultMaxTurns: 24`.
- **Likely target paths:** `src/web-server/run-driver.ts`, `src/web-server/routes/runners.ts`,
  `.pi/subagents.json`.
- **Donor reference:** `src/workflow/doc-turn/{claude-runtime,pi-runtime,exec}.ts`,
  donor `subagents.json`.
- **Depends on:** PORT-00.
- **Verification:** **NEW** `test/runner-permission-mode.test.ts`; `npx vitest run test/runner-permission-mode.test.ts test/run-driver.test.ts test/claude-runner.test.ts`; acceptance: read-only mode asserts the exact flags and that `--dangerously-skip-permissions` is absent; default unchanged.
- **Rollback:** revert adapters; default path untouched.
- **Effort:** **M (estimate)**.
- **Decision gate:** user must accept an opt-in mode that narrows runner capability.

### PORT-13 — Request body cap + Mermaid default-safety
- **Outcome (default-safe, may adopt):** add an explicit request body-size cap on the ask
  path and port Mermaid hardening (`htmlLabels:false`, `suppressErrorRendering`, DOMPurify
  labels). **Keep the default raw-HTML-off posture** — the target's rawHTML-off is **already
  safe**, so richer HTML is **not required security hardening**. If richer HTML is ever
  wanted, it is an **optional separate capability** with `rehypeRaw → rehypeSanitize →
  rehypeHighlight` order pinned by tests.
- **Likely target paths:** `src/web-server/respond.ts` (cap), `web/src/components/MermaidDiagram.tsx`
  (mermaid), optionally `web/src/components/MarkdownViewer.tsx` (separate capability).
- **Donor reference:** donor `console-server.ts` body cap, `web/src/console/mermaid-diagram.tsx`,
  `detail-view.tsx` (optional capability).
- **Depends on:** PORT-00.
- **Verification:** **NEW** `test/respond-body-cap.test.ts`, **NEW** `test/mermaid-config.test.ts`;
  `npx vitest run test/respond-body-cap.test.ts test/mermaid-config.test.ts test/web-client-core.test.ts`;
  oversize body → 413; mermaid `%%{init}%%` cannot downgrade `securityLevel`. Optional
  richer-HTML capability needs raw `<script>`/`on*`/`javascript:` tests.
- **Rollback:** revert route/component.
- **Effort:** **M (estimate)**.
- **Decision gate:** confirm web surface in scope (gate includes `web` typecheck); richer HTML is a **separate** decision (default off).

### PORT-14 — Release safety gates (auto tag-trigger + postinstall DEFERRED)
- **Outcome (may adopt):** the release **safety gates**, as four explicit ADOPT items:
  1. **`tag == package.json version` gate** — assert the version about to publish matches the
     tag (`release.yml:76,89` today; no gate).
  2. **Idempotent publish** — guard with `npm view "$pkg@$v"` before `npm publish`
     (donor `release.yml:83-84`); a re-run must not bump again or fail on a duplicate.
  3. **Idempotent `gh release`** — guard with `gh release view` before `gh release create`
     (donor `release.yml:93-96`).
  4. **Release-shape test** — a `set -euo pipefail` + guarded publish/release shape test
     (donor `test/workflow-policy.test.ts`) asserting the workflow cannot silently swallow
     an exit code.
  Preserve the **manual release as the default** option; **never** perform an actual publish
  as part of acceptance without separate approval. **Clearly separate and DEFER** auto
  tag-trigger and any postinstall/global config writes (they remain out of scope absent
  explicit opt-in). Note: global config/network side effects **cannot** be rolled back by
  `git revert`.
- **[X] Retired-chain lesson + protected-main hazard.** The donor *had* a multi-hop auto
  release chain (two-workflow gate `c3ec9df` #28 → one workflow `7a3109c` #29 → tag baseline
  `a00c672` #31 → history-derived versions `7f0d017` #32 → rename `1536b08` #33 → restored
  `prepare`/`publish` `24d331f` #37 → one tag-triggered job `939ddfc` #54) and **retired** it:
  `release-from-main` pushed the bump commit straight to a **protected `main`** (approving
  review required, no auto-merge, no admin bypass), so five releases landed a tag with no
  matching main commit, compounded by an `if`-without-`else` exit-code bug. **Rule: never push
  a version-bump commit to a protected branch from CI — tag a reviewed commit.** **ARCS's own
  `release.yml:96` does `git push --follow-tags origin HEAD:${{ github.ref_name }}` from CI —
  the same hazard — and publish (`:89`) is non-idempotent.** ARCS is uniformly Node 24 (do not
  copy the donor's Node 20 release / Node 22 CI mismatch). See
  [deep-dive-ledger-graph-build-commits.md §C.4](./deep-dive-ledger-graph-build-commits.md#c4-the-release-chain-lesson-2854-c).
- **Likely target paths:** `.github/workflows/release.yml`; `package.json` scripts.
- **Donor reference:** donor `release.yml` (tag gate, idempotent publish, `gh release`
  guard, `set -euo pipefail`). The donor postinstall (`scripts/cc-arcs-postinstall.mjs`) is
  **reference only — deferred**.
- **Depends on:** PORT-00.
- **Verification:** **NEW** `test/release-workflow.test.ts` simulating tag==version pass/fail,
  an idempotent-publish **simulation** (no network), and a `gh release` guard, plus a
  release-shape assertion (`set -euo pipefail`, guarded steps); `git diff --check`.
  ARCS's `test/workflow-policy.test.ts` tests **domain policy, not release shape** — the new
  test is separate.
- **Rollback:** revert workflow/scripts (no runtime impact).
- **Effort:** **S–M (estimate)**.
- **Decision gate:** **actual publish and any global-install/postinstall write require
  explicit, separate approval.** Resolve the protected-main hazard (tag a reviewed commit vs.
  keep pushing to `main`) as a distinct decision.

## Deferred / rejected (with rationale — no silent omissions)

**Deferred until specifically approved:**
- Whole-console rewrite (donor 168-file console) — large UI surface, high coupling, low marginal value vs. effort.
- Vendored Pi agent runtime + version pin — version-skew risk; installed upstream version unverified (T3/G-12).
- Auto tag-trigger release and automatic postinstall/global config writes — external/global side effects not git-revertible (PORT-14).
- Destructive `plan delete --cascade` / `deleteDocCascade` — destructive; needs explicit design (PORT-09).
- doc-turn section-authoring runtime — net-new editor subsystem (PORT-09 boundary).
- Optional richer-HTML rendering — target rawHTML-off is already safe; capability, not a fix (PORT-13).
- Cross-project listing helper — target already has search; add only on demand (PORT-11).
- **T7** (web receipt returns capped diff by default) — scope decision inside PORT-07, loopback-bounded.
- **T9** (code-chunk redaction) — policy decision inside PORT-17; chunk weighting suggests hint, not authoritative.
- **T11** (pid reuse on cancel) — low, loopback; needs restart-cycle design, not a quick port.
- **D3** (donor hunk-prefix parsing), **D4** (donor promotion claim race), **D5** (donor pairing token) — donor-side; not imported.
- **`bundle/` directory rename** (`264150a` #52) — cosmetic; the donor's own message shows text
  search misses split-path references (`bundle-installer.ts`), so ARCS's equivalent risk in
  `scripts/deploy-*.mjs`/`src/cli/bundle-installer.ts` is real churn for no behavior gain.
- **Owner-nested skill dirs** (`a18c0bd` #60) — ARCS has a single skill owner; collision/
  ownership checks only pay off with ≥2 owners.
- **Auto tag-triggered release** (`939ddfc` #54) — external side effect, not git-revertible;
  conflicts with ARCS's deliberate manual publish.

**Rejected:** donor storage layer (plain `writeFile`); narrower schemas; raw direct storage
writes; donor shell-interpolation git helpers (D2); donor non-constant-time token compare +
dead studio/SSE pairing path (D5); corporate provider defaults; revival of retired roles
while target gates forbid them; MCP transport reintroduction; **the Pi extensions catalogue,
its `build-pi-extensions-bundle.mjs` snapshot (source is a maintainer's live `~/.pi/agent`,
CI-unreproducible) and its vendored host-internal forks** (`5017322` #77); **uncommitting the
prompt mirrors** (`9c7df6d` #47 — ARCS's `test/prompt-parity.test.ts` is strictly stronger);
**pushing a version-bump commit to a protected `main` from CI** (the donor #37 failure; ARCS
`release.yml:96` currently does this — see PORT-14); donor Node 20-vs-22 CI/release mismatch
and `@traveloka` restricted publish; donor `baselineCommit` (duplicates `startHead`); donor
`FileRef` shape; `gh pr view` as a hard ledger dependency; donor console graph shell
(`b4e3507` #75).

## Traceability: findings → roadmap

| Finding | Roadmap item | Notes |
|---|---|---|
| T1 worktree policy text | PORT-00b | decision (a)/(b) |
| T2 sub-agent prompt duplication | PORT-16 | SSOT extraction |
| T3 config depth/turns | PORT-12 | opt-in, measured, unverified runtime |
| T4 prompt budget | PORT-16 | measurement required |
| T5 lexical containment | PORT-17 | realpath policy |
| T6 receipt ordering | PORT-07 | ordering + diagnostics |
| T7 web diff default | PORT-07 | scope decision (deferred detail) |
| T8 chunk staleness | PORT-07 | knowledge-entry level |
| T9 chunk redaction | PORT-17 | policy |
| T10 runner permissions | PORT-12 | opt-in mode |
| T11 pid reuse | Deferred | needs restart-cycle design |
| T12 request body cap | PORT-13 | default-safe |
| T13 taskMetaSchema | PORT-04 | current fields only |
| T14 dry-run executes mutations | PORT-01 | [E] reproduced |
| T15 help/version | PORT-03 | extend existing help-generator |
| D1 donor storage | Rejected | keep target primitives |
| D2 shell interpolation | Rejected (pattern) | use argv subprocess |
| D3 hunk prefixes | PORT-08 | pin `noprefix`/`mnemonicPrefix` + reuse target quote normalization |
| D4 promotion claim race | Deferred | donor-side; convergence framing (deep-dive §A.8 confirms) |
| D5 pairing token | Rejected | dead path |
| D6 license divergence | PORT-15 | pre-copy rights gate |
| D7 ledger read-outside-lock | PORT-08 | re-read inside the lock [X] |
| donor retired release chain | PORT-14 | never push bump commit to protected main |
| donor filesystem skills walk | PORT-18 | keep excludePatterns + 0/0 lint gate |
| donor Pi ownership/revert discipline | PORT-19 | preflight + tracked settings revert |

## Integration hard gates (all items)

Every item touching `src/` or `test/` must pass on the working tree before it is considered
landed:

```sh
npm test                                   # vitest run
npm run typecheck                          # tsc --noEmit
npm run lint                               # biome check src/ test/ web/
npm run build:opencode-bundle              # regenerate prompts/bundle
node scripts/lint-bundle.mjs               # bundle integrity (post-rebuild)
npm --workspace @arcs/web run typecheck    # when web/ is touched (PORT-13)
```

Expected evidence: test file/test counts green, all commands exit 0, `lint-bundle` reports
`{errors:0,warnings:0}`. Baseline recorded in [verification.md §2](./verification.md#2-target-quality-gates-executed-read-only);
**note the baseline was captured at the ~10-dirty-file snapshot and must be re-measured on
the current tree before landing.** The audit did not run `build`/`build:web`; bundle lint ran
on the existing bundle only.

## Rollback posture

- CLI/parser/schema/config/help ports are local reverts (single module).
- Receipt/ledger changes keep receipts authoritative; a ledger is **disabled/archived, never deleted**.
- Docs engine is opt-in and off by default; rollback disables the **new** commands and
  preserves existing `doc update`/`proposal-doc`/accepted proposals.
- Path-containment and runner-permission change are policy/opt-in; defaults untouched.
- Release safety gates are test-simulated; **no actual publish**, no global writes, and
  global/network side effects are not git-revertible.
