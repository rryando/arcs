# Deep dive: tech-doc → plan (prompt + lifecycle) and the diff tools

**Status: DRAFT / evidence candidate — not approved, no tasks/plans/diagrams exist.**
Companion to [technical-report.md](./technical-report.md) and
[porting-roadmap.md](./porting-roadmap.md). This file **corrects and refines** the earlier
P3 / PORT-08 / PORT-09 material; where the earlier audit text and this deep dive disagree,
**this deep dive governs** and the earlier text is flagged inline.

| | |
|---|---|
| Target ("ARCS") | `/home/rryando/Work/arcs` (`@rryando/arcs` 5.2.3) |
| Donor ("cc-arcs") | `/home/rryando/Work/agent/cc-arcs` (`@traveloka/cc-arcs` 0.9.0) |
| Donor HEAD | `b9c9f6380db9f823111e75415bf124bf34a10e02` |
| Audit baseline | target HEAD `a9e7e1bddb405aad1d2e9d70420b525f76b3cec1` |
| Current tree | `271296bc96c7c608f0e5c2d7be2a83e2fa7fa4f8` (`feat/jev-judgment-policy`) — **re-measure before landing** |

**Provenance.** Two source-cited specialist deep dives were the starting evidence
(`/tmp/arcs-cc-audit-handoff-nhxm7r0n/doc-plan-lifecycle.md`, `…/diff-tools.md`). The
documentation owner **re-read the cited donor anchors** and the ARCS-side anchors before
persisting each claim here; anchors are labelled `donor` / `target` and were not taken on
trust. `jev_screen` / `jev_verify` / `jev_judge` returned **`unavailable (no_api_key)`**, so
no probabilistic verdict exists — every label below is manual and source-backed. Confidence
tags **[C]/[E]/[I]/[U]/[X]** follow the [README legend](./README.md#evidence-provenance-and-confidence-legend).

---

## Part A — Tech-doc → plan: prompt and lifecycle

### A.1 Kinds

Exactly two authored flavours: `tech-doc` (system/backend change) and `design-doc` (UI/design
surface). Both carry the identical lifecycle and both promote into plans+tasks; the kind only
selects which body template the author fills. A change touching both is authored as **two
docs**.

- `DOC_KINDS = ["tech-doc", "design-doc"]` (donor `src/utils/storage-utils.ts:69-71`) [C].
- `writing-tech-doc/SKILL.md:12`, `writing-design-doc/SKILL.md:12` (donor
  `bundle/cc-arcs/skills/cc-arcs/…`) [C].

### A.2 Status transition table (code-enforced)

Statuses (donor `src/utils/storage-utils.ts:80-88`): `draft → in_review → accepted →
implemented → superseded` (terminal). The transition map (donor
`src/utils/storage-utils.ts:100-109`) is **enforced**, not advisory:

| From | Allowed to |
|---|---|
| `draft` | `in_review`, `superseded` |
| `in_review` | `draft`, `accepted`, `superseded` |
| `accepted` | `in_review`, `implemented`, `superseded` |
| `implemented` | `superseded` |
| `superseded` | — (terminal) |

- `draft → accepted` is impossible by construction; review is reversible
  (`in_review → draft`, `accepted → in_review`); `superseded` is reachable from everywhere
  and terminal (donor `storage-utils.ts:100-109`) [C].
- `DOC_PROMOTABLE_STATUS = "accepted"` (donor `storage-utils.ts:109`) — the **only**
  promotable status, enforced at the promote handler (donor `src/cli/commands/doc.ts:754-756`,
  `docNotPromotable`) [C].
- `validateDocTransition` refuses any hop absent from the table; a same→same no-op is legal
  for idempotent re-writes (donor `storage-utils.ts:201-206`, error
  `invalidDocTransition` at donor `src/utils/errors.ts:84`) [C].

### A.3 Pinned content-addressed revision

Promotion pins the body immutably before any plan/task write:

- `snapshotTdd` sha256-hashes the body and writes `workflow/tdd/<docId>/<hash>.md`
  write-if-absent (donor `src/workflow/artifact-service.ts:94-105`; hash via
  `computeRevisionHash`, donor `src/workflow/journal.ts:134-136`) [C].
- `readPinnedRevision` resolves a full hash or an unambiguous prefix and **throws on an
  ambiguous prefix** (donor `artifact-service.ts:57-79`) [C].
- `revisionHash` is therefore **content-addressed and never mutable**; a changed body is a
  **new** revision (see A.8).

### A.4 What `promote` does (ordered)

`promote` (donor `artifact-service.ts:154-311`; command
`src/cli/commands/doc.ts:734-855`) runs, in order:

1. **Pin** the body (A.3).
2. **Journaled write** creating **one plan** at status `planned` with a **deterministic id**
   `tdd-<docId>-<shortHash>` (`computePromotionId`, donor `journal.ts:142`; id derived at
   donor `artifact-service.ts:82-84`, applied at `:157`). Plan body generated pure/deterministic by
   `renderPromotedPlanBody` (`src/workflow/promoted-plan-body.ts:47-76`): a `## Source`
   pointer + `## Tasks` table (`# | Task | Sections | Files | Verify`) [C].
3. **One task per Task Breakdown item** (donor `artifact-service.ts:251-295`).
4. **`recordDocPromotion` AFTER the write commits** — appends `planIds`/`revisionHash` onto
   the doc only after the plan+tasks land (donor `doc-store.ts:318-341`, called from
   `artifact-service.ts` post-commit; `planIds`/`revisionHash` are the **only** writer's
   fields, deliberately kept off `UpdateDocInput`, donor `doc-store.ts:116-128`) [C].

`--tasks-file` may override the parsed breakdown (donor `doc.ts:767`) [C].

### A.5 Task Breakdown directives

- Heading declared once as `TASK_BREAKDOWN_HEADING = "Task Breakdown"` and shared by template
  renderer, parser and validator, so a template rename cannot silently stop being promotable
  (donor `src/utils/doc-templates.ts:69`) [C]. The parser also tolerates a trailing suffix
  like the source template's "…and Timeline" via `extractSectionLines` (donor
  `doc-templates.ts:191-214`) [C].
- `parseTaskBreakdown` (donor `doc-templates.ts:526`) pulls recognised parentheticals out of
  each list item (donor `doc-templates.ts:247`): `(priority: …)`, `(verify: …)`,
  `(acceptance: …)`, `(refs: <slug>[,…])`, `(files: <path[:anchor]>[,…])`, `(scope: …)`,
  `(skill: …)`. `files:` → task `sourceFiles`, `scope:` → `scope`, `skill:` → `skill`
  (donor `doc-templates.ts:219-291`) [C].
- `refs:` values are `slugifyHeading`-normalized, so a raw heading **or** a ready slug both
  resolve (donor `doc-templates.ts:261-267`) [C].
- **Unrecognised parentheticals stay in the title verbatim** — e.g. an estimate like `(2MD)`
  (donor `doc-templates.ts:517-522`, confirmed in the hint text at `:73-77`) [C].
- HTML comments and blank items are skipped; nested list items are treated as their own tasks
  (donor `doc-templates.ts:530-535`) [C].

### A.6 docRefs stamping

On promote, `docRefsFor` stamps `[{docId, revisionHash, sections}]` onto each task (donor
`artifact-service.ts:240-245`; type `TaskDocRef` at donor `src/utils/task-store.ts:52-56`,
field on `CreateTaskInput`/`TaskMeta` at `:76-81,111-112`, applied at `:275`) [C].
`docRefs` is **deliberately absent from `UpdateTaskInput`** — only promotion can write it
(donor `task-store.ts:76-81`), mirroring how `planIds` is kept off `UpdateDocInput` [C].

### A.7 Task brief excerpts from the pinned revision

`task brief` resolves `task.docRefs[0]`, calls `readPinnedRevision` and excerpts exactly the
cited sections from the **pinned** revision (donor `src/cli/task-brief.ts:106-134`; imports
`excerptSections` from `doc-ranges`, `readPinnedRevision` from `artifact-service`, at
`:24,:31`) [C]. So citations remain stable even after the doc body changes.

### A.8 Idempotency by content

- The idempotency key is `doc:<docId>@<revisionHash>` (donor `doc.ts:825`) [C].
- **Unchanged body ⇒ no second plan** (same revision ⇒ same deterministic plan id ⇒
  existence check skips). **Changed body ⇒ new revision ⇒ a deliberate new plan**
  (`promoting-docs/SKILL.md:49-50`) [C].
- **Crashed promotion is repaired by re-running**: `performWrites` skips an already-existing
  plan (donor `artifact-service.ts:266`) and already-existing tasks (`:291`) [C].
- **Honest concurrency caveat:** `promote` does `findEntry` (journal read) →
  `appendEntry(started)` (per-append lock) → `performWrites` → `appendEntry(committed)`
  (donor `artifact-service.ts:159-207`). **No lock spans the whole sequence**; the code
  comment calling `started` "the CAS gate" (`:172`) **overstates** it — two concurrent
  callers can both read no-prior-entry and both proceed. Convergence is protected by
  deterministic ids + existence checks, not atomicity. The audit's **D4 is correct**
  ([technical-report.md §5.2](./technical-report.md#52-donor-side-context-for-what-not-to-import)).

### A.9 Refusals (deterministic, fail before any write)

| Error | Trigger | Anchor |
|---|---|---|
| `DOC_NOT_PROMOTABLE` | status ≠ `accepted` | donor `doc.ts:754-756`; factory `errors.ts:101` |
| `DOC_TASK_BREAKDOWN_EMPTY` | zero parsed items | donor `doc.ts:788`; factory `errors.ts:114` |
| `DOC_REF_UNRESOLVED` | a `refs:` slug has no section in the **pinned** revision; thrown by `validatePromoteTasks` **before** the journal's `started` claim | donor `artifact-service.ts:217-237`; factory `errors.ts:216` |
| `INVALID_FILE_REF` | `sanitizeFileRefs` rejects a `files:` value during preflight | donor `artifact-service.ts:221-225`; factory `errors.ts:126` |
| `TDD_REVISION_NOT_FOUND` | pinned file unreadable at write time | donor `artifact-service.ts:255-258`; factory `errors.ts:204` |
| `INVALID_DOC_TRANSITION` | illegal status hop | donor `storage-utils.ts:201-206`; factory `errors.ts:84` |

A refused promotion (e.g. `DOC_REF_UNRESOLVED`) is indistinguishable from one never
attempted because the refusal precedes the `started` claim (comment donor
`artifact-service.ts:210-216`) [C].

### A.10 Code-enforced vs prompt-only — ownership split

**Code-enforced** (the CLI actually checks): status transitions; the promote gate
(`accepted` only); empty-breakdown refusal; file-ref sanitization; doc-ref resolution against
the pinned revision; deterministic ids; journal idempotency; docRefs stamping; pinning.

**Prompt-only** (nothing in the CLI verifies the caller): *who may call which command*
(author vs main); "don't skip review to unblock yourself"; "one doc per design". The
`cc-arcs-docs` prompt owns knowledge/doc persistence **by prose convention only** (donor
`src/cli/prompts/fragments.ts:29-31`) [C].

Driving skills (donor `bundle/cc-arcs/skills/cc-arcs/`): `writing-tech-doc`,
`writing-design-doc`, `promoting-docs`, `doc-section-edit`, `executing-plans` (also
`writing-plans`, `update-docs`). Role: the `cc-arcs-doc-author` sub-agent
(donor `src/cli/prompts/cc-arcs-doc-author.ts`):

- The author proposes the next legal hop and runs `doc update-meta --status=…` **only when
  dispatched**; the prompt states promote "belongs to main via `promoting-docs`"
  (donor `cc-arcs-doc-author.ts:33`) [C].
- Ordering is prose-coordinated: author scaffolds + advances `draft→in_review`; a dispatched
  `update-meta --status=accepted`; **main** runs `doc promote` per `promoting-docs`
  (preflight `doc get`/`doc breakdown`/`--dry-run`, refusal table, `--tasks-file`); main's
  loop then consumes the promoted plan via `executing-plans`.
- `doc-section-edit` is the **console section-turn** surface (propose→approve), explicitly
  decoupled: safety invariants travel inline, "if the two ever disagree, the inline rules
  win" (donor `doc-section-edit/SKILL.md:14`) — **this is the runtime PORT-09 excludes**.

### A.11 Minimal-viable promote slice, and the gap vs ARCS

The earlier audit framed the donor doc subsystem as one P3 **"L" blob, "the single largest
donor-only surface."** [X] That **overstates the mandatory core**: the largest parts are
cleanly separable, and the promote path is a bounded slice.

**Portable core (estimate ≈2 700 LOC)** — donor file byte counts measured at donor HEAD
(full files: `doc-store.ts` 466, `doc-templates.ts` 587, `doc-ranges.ts` 535,
`artifact-service.ts` 311, `promoted-plan-body.ts` 76, `journal.ts` 226, `doc.ts` 856 =
3 057 lines total; excluding the section-edit half of `journal.ts` and the delete/cascade +
section handlers of `doc.ts` brings the promote path to ≈2 700):

- **Schemas/data:** `doc-store.ts` (DocMeta + `planIds`/`revisionHash`/`supersedes`, CRUD,
  `recordDocPromotion`); the doc slice of `storage-utils.ts` (`DOC_KINDS`, `DOC_STATUSES`,
  `DOC_STATUS_TRANSITIONS`, `DOC_PROMOTABLE_STATUS`, `validateDocKind/Status/Transition`,
  `sanitizeFileRefs`); `docMetaSchema` + `taskDocRefSchema` (`json-schemas.ts:232,260`).
- **Parse/template:** `doc-templates.ts` (`TASK_BREAKDOWN_HEADING`, `DOC_TEMPLATES`,
  `DOC_REQUIRED_SECTIONS`, `parseTaskBreakdown`, `extractSectionLines`,
  `docSectionIsFilled`/`docBodyContentLength`) and `doc-ranges.ts` (`slugifyHeading`,
  `sectionRange`, `outlineHeadings`, `excerptSections`).
- **Promote engine:** `artifact-service.ts` (`snapshotTdd`, `promote`, `readPinnedRevision`,
  `validatePromoteTasks`, `performWrites`), `promoted-plan-body.ts`, and the **promotion**
  half of `journal.ts` (`computeRevisionHash`, `computePromotionId`, `appendEntry`,
  `findEntry`, `readJournal`) — **not** `SectionEditEntry`/`appendSectionEdit`.
- **Task wiring:** `TaskDocRef` + `docRefs` on `TaskMeta`/`CreateTaskInput` only.
- **Commands:** a `doc` group
  `create|list|get|template|update-meta|update-body|outline|breakdown|promote`.
- **Validator:** the `doc-health`/`citations` checks (donor `utility.ts:494-560,644-694`),
  advisory.
- **Errors:** `invalidDocTransition`, `docNotPromotable`, `docTaskBreakdownEmpty`,
  `docRefUnresolved`, `tddRevisionNotFound`, `invalidFileRef`.

**Excluded cleanly:** `src/workflow/doc-turn/**` (3 664 LOC across 12 files), the
section-edit journal + SSE runner, `web/src/console/authoring/` (7 files) and the 168-file
`web/src/console`.

**Gap vs ARCS today [C]:** ARCS `proposal-doc` is a two-state **file** lifecycle —
`.proposal.md` (pending) vs `.accepted.md` (accepted), status inferred from the filename
(target `src/cli/commands/proposal-doc.ts:254-259,333-336`); `proposal-doc promote` merely
**renames the file and prints an `arcs plan create --body-file=…` command string**
(`proposal-doc.ts:407-476`) — it creates no plan/tasks. ARCS has **no** `task brief`, no
`docRefs`, no pinned revisions, no breakdown parser, no `doc-health`.

**Collisions / decision gates:**

- **`doc` namespace ALIAS COLLISION** — ARCS already defines `doc update` as an alias for
  `project update-doc` (target `src/cli/commands/dependency.ts:190-191`, visible in
  `arcs --commands --json`). Porting a donor `doc` group **shadows that alias**. Pick a
  distinct group name (e.g. `tech-doc`) or reconcile. **Explicit decision gate.**
- **Two `promote` verbs** — ARCS `proposal-doc promote` (rename-only) vs donor
  `doc promote` (plan+tasks). Confusing if both ship. **Explicit decision gate.**
- **Plan-id derivation** — donor derives from `(docId, revisionHash)`; ARCS `plan create`
  derives from the title (`plan.ts` accepts `--body-file`).
- **Graph** — donor adds doc→plan edges; ARCS `EdgeRelation` has no doc node
  (target `src/retrieval/graph-types.ts:4-14`); needs a doc node type (PORT-10).
- **Parallel "stage one" skills** — `writing-proposals` and `writing-tech-doc` would both
  claim the DAG's design layer.

---

## Part B — Diff tools

### B.1 Inventory (donor)

**Atom — `getCommitChanges`** (donor `src/utils/git.ts:207-233`). Four shell calls:
metadata (`:210`), `--numstat`→`parseNumstat` (`:159-179`), `--unified=0`→`parseHunks`
(`:181-202`), and `git show <sha> | git patch-id --stable` (`:221`). It **stores** full sha,
subject, author, authoredAt, per-file `{path, additions, deletions, hunks[]}` (hunk `@@`
**header strings only**), and patchId. It stores **no patch body**, and returns `null` when
the sha does not resolve (`:208-212`) [C].

**Ledger entries — `ChangeEntry`** (donor `src/workflow/change-ledger.ts:38-67`), four
`ChangeKind`s (donor `change-ledger.ts:33`):

- `commit`: sha + patchId + subject/author/authoredAt + files[] — a **snapshot**, not a
  re-render. Written by `recordCommits` (donor `change-ledger.ts:208-257`), shared by `done`
  and `record-change`.
- `pending`: worktree diffstat with `hunks:[]` + untracked **names** (donor `recordPending`
  `change-ledger.ts:259-277`). No content; git cannot reconstruct it later.
- `pr`: `{url, headSha?, state?}` from `gh pr view --json headRefOid,state` (donor
  `changes.ts:56-75`) — optional, degrades to URL only.
- `tombstone`: `{taskId, sha}` retraction (donor `removeChange` `change-ledger.ts:162-169`).

`readChanges` (donor `change-ledger.ts:111-160`) applies tombstones, `(taskId,sha)` dedup,
and pending-supersession. **`reachable` is computed on read** via
`git merge-base --is-ancestor <sha> HEAD` only when `cwd` is passed (donor
`change-ledger.ts:145-147`) — **never stored**.

**Read side — `task changes` / `plan changes`** (donor `changes.ts:283-372`): `readChanges` +
`summarizeChanges` (donor `change-ledger.ts:279`). `--patch` runs `withPatches`
(donor `changes.ts:67-78`) which **re-renders** each **reachable** commit's full unified diff
via `getCommitPatch` (donor `git.ts:263-268`), optionally narrowed by `--files`;
`reachable === false` records are skipped. Also `--limit`.

**Write side — `task record-change`** (donor `changes.ts:109-280`): `--commits`
(`resolveCommit`), `--range` (`listCommits`; a leading `..` expands to
`task.baselineCommit`, donor `changes.ts:160-168`), `--pr`, `--remove` (prefix-match against
**recorded** shas, not git, `:193-217`). Everything is resolved before writing (`:141`).

**Separate family — doc-range splice/rebase "diffing" (no git):** `resolveRange` (donor
`src/utils/doc-ranges.ts:151-228`) verifies claimed text (`normalize(body.slice(…)) ===
normalize(selectedText)` `:168`); `validateReplacement` (`:491-528`) and `spliceRange`
(`:534-536`) are structural; `rebaseDoc` (donor `workflow/doc-turn/proposal-store.ts:309-353`)
offset-shifts siblings and **re-verifies** by exact `newBody.slice(…)===sibling.range.selectedText`
(`:340`). It depends on the in-memory body + `baseSha256`, **not** a pinned revision. This is a
**no-op without the docs subsystem** and belongs with PORT-09, not the ledger.

### B.2 Stored vs re-rendered

| Data | Stored in ledger? | Re-rendered? |
|---|---|---|
| commit sha/subject/author/authoredAt | yes | — |
| per-file `+/-` and `@@` hunk headers | yes | — |
| patch **body** | **no** | only while the sha is `reachable` (`--patch`) |
| `pending` worktree diffstat + untracked names | yes (names only) | never (git cannot reconstruct) |
| `reachable` | **no** | computed on read via `merge-base --is-ancestor` |
| `patchId` | yes (advisory) | never used for matching |

The ledger is a **pointer index, not a patch store**.

### B.3 Port dependency graph

Modules a literal port pulls in (donor `change-ledger.ts:16-30` imports):

- `retrieval/graph-invalidate.js` — **ARCS has** (`src/retrieval/graph-invalidate.ts`).
- `utils/file-lock.js` `withLock` — **ARCS has** (`src/utils/file-lock.ts:82`).
- `utils/storage-utils.js` `ensureDir`/`nowISO` — **ARCS has** (`:307/:405`).
- `workflow/read-file-safe.js` — **ARCS lacks** (fold the ~5 needed lines into ARCS helpers;
  do **not** add a new module).
- `utils/git.ts` additions: `isValidSha`, `isValidRevisionRange`, `getHeadCommitFull`,
  `resolveCommit`, `isAncestor`, `listCommits`, `getCommitChanges`/`parseNumstat`/`parseHunks`,
  `getWorktreeDiffstat`, `getCommitPatch`. **ARCS's `git.ts` is argv/timed**
  (`execFileAsync`, target `src/utils/git.ts:97`) **while the donor additions are shell-string
  `execSync`** (donor `git.ts:11-20`) — the port **must re-express as argv**.
- `src/cli/commands/changes.ts` needs donor `getProjectDir`, `plan-store.findPlan`,
  `task-store.getTask`, `project-workspace.readProjectGitWorkspace` — **ARCS lacks the
  latter three conventions** (uses `resolveProject`, `project-memory`, and
  `resolveTaskRepoRoot`/meta.json workspacePaths). Near-total rewrite against ARCS naming.
- `done` wiring: donor uses `readProjectGitWorkspace` + `baselineCommit`; ARCS `done.ts`
  already resolves `repoRoot` via `resolveTaskRepoRoot` and `startHead`, and plan receipts
  prefer `worktree.baseCommit`. ARCS has **no `baselineCommit`** — **reuse the target
  `startHead`/worktree baseline**, don't add a duplicate field.
- graph edges: ARCS `EdgeRelation` has no `task_changed_file` and `NodeType` no `"doc"`
  (target `src/retrieval/graph-types.ts:4-14`); donor adds both and a
  `sourceHashes.changes` cache key.

### B.4 Overlap vs ARCS receipts and code-snippet

**Genuinely additive:** `reachable`/dangling-SHA detection and tombstones (ARCS receipts are
single-file, last-write-wins, with no history/retraction); commit prefix/range selection and
`plan changes` roll-up; `task_changed_file` edges.

**Duplicate (do not reinvent):** ARCS **already parses diffs into code ranges** —
`parseDiffFileRanges` (target `src/utils/code-snippet.ts:289`) and `deriveDiffCodeRanges`
(`:347`), consumed by `done --learn`. Donor `parseHunks` is a weaker predecessor; the ledger
should store `@@` headers for **display** only and keep ARCS's range derivation for **chunk
capture** [C].

**Complementary, must INDEX not replace:** ARCS receipts store a **capped** diff
(`RUN_REPORT_DIFF_MAX_LINES = 300`, target `src/utils/run-report.ts:101`; written as
`<id>.json` + `<id>.diff` by two `writeFileSync` calls, target `src/utils/report-store.ts:88-89`),
worktree-aware and with synthesized untracked content (target `run-report.ts:61-96,341`).
The ledger stores **no** patch body and **cannot** reproduce receipt capture. **The ledger
must index receipts, not replace or duplicate them.**

### B.5 Correctness risks

1. **Shell interpolation** (audit D2, target `technical-report.md` §5.2): helpers are
   regex-guarded (`SHA_PATTERN` donor `git.ts:90`; `REVISION_PATTERN` `:97`; `..` excluded
   `:114`) but still shell strings (`git show … | git patch-id` `:221`). `getCommitPatch`
   filters `/^[\w./@-]+$/` (`:265`) — that regex **accepts `..` and a leading `/`**, so "safe
   paths" is looser than it reads. **Port as argv.**
2. **Prefix fragility** (audit D3): `parseHunks` keys on `+++ b/(.+)` (donor `git.ts:186`)
   with **no** `-c diff.noprefix=false`/`diff.mnemonicPrefix=false` pin; under
   `diff.noprefix=true` hunks silently vanish (`hunks.get(path) ?? []`, `:216`), and a C-quoted
   `+++ "b/pa th"` fails the regex. **ARCS already pins both** (target `run-report.ts:124`) and
   **normalizes quotes** (`normalizeDiffPath`, target `code-snippet.ts:221`) — inherit that.
3. **TOCTOU / duplicate window**: `recordCommits` reads the ledger (donor `change-ledger.ts:213`)
   **outside** the append lock (`withLock` is inside `appendChange`, `:83-86`); concurrent
   writers duplicate `(taskId,sha)` lines. Reads are deduped (`:135-139`), so listing is stable
   but the log grows.
4. **Line-offset drift**: the offset shift is exact (`:311`) and re-verified (`:340`); the
   `\n`-count line shift (`:312`) can be off by one when newline endings differ — cosmetic
   (line bounds are display-only) but not a proven invariant.
5. **patchId is advisory only**: recorded (`:221`, `:240`) and surfaced as advisory text, but
   **never used for matching** — dedup is by `(taskId,sha)`. It does **not** let the ledger
   follow a rebase; "dangling SHAs handled gracefully" means **reported**, not **resolved**.
6. **Untracked under-reporting**: `getWorktreeDiffstat` (donor `git.ts:245-261`) slices `??`
   lines (`:250-253`) — an untracked **directory** collapses to one `dir/` entry (no
   contents), quoted paths keep their quotes, and a tree dirty only via a mode/submodule
   change with no numstat and no `??` returns **`null`** (`:258-259`). ARCS should enumerate
   with `ls-files --others --exclude-standard` (as `run-report.ts` does).
7. **Pending supersession quirk**: a `pending` entry is superseded by **any** later commit for
   the task (donor `change-ledger.ts:122-134`) even if that commit does **not** cover the
   uncommitted work.

**Naive-port regressions to avoid:** re-introducing shell-string git; dropping the
`noprefix` pin; diffing `meta.json[0]` instead of the worktree; storing patch bodies beside
receipts; adding `changes.jsonl` without a cache hook (donor `appendChange` calls
`invalidateGraphCache`, `:87`; ARCS cache keys on `sourceHashes`, target
`graph-types.ts:31` — add `sourceHashes.changes`).

### B.6 Minimal-viable subset and an explicit do-not-port list

**Minimal-viable subset:**

1. argv git helpers incl. `-c diff.noprefix=false -c diff.mnemonicPrefix=false` + timeout.
2. `src/utils/change-ledger.ts` append-only JSONL, lock-guarded, kinds
   `commit|pending|pr|tombstone`, `readChanges` (tombstone/dedup/supersession/`reachable(cwd)`),
   `summarizeChanges`, **no patch body**.
3. Wire `done` to record `<startHead..HEAD>` (worktree-aware) + a `pending` entry only when dirty.
4. `task changes`/`plan changes` (`--patch` re-renders when reachable, `--files`, `--limit`) +
   `task record-change --commits/--range/--pr/--remove`.
5. `task_changed_file` edge + `sourceHashes.changes` + an `EdgeRelation` member.
6. dangling/pending checks in ARCS `validate`.

**Acceptance (vitest; ARCS tests live in `test/`):** new `test/change-ledger.test.ts`
(mirror donor `test/change-ledger.test.ts`) and `test/integration/change-ledger-git.test.ts`
(mirror donor `test/integration/change-ledger-git.test.ts`, both present in the donor);
**new** `test/git.test.ts` asserting argv/no-shell + the `noprefix` pin. CLI: `arcs task
changes <slug> <id> --patch` re-renders committed patches and the ledger file contains **no**
patch body; a dangling sha reports `reachable:false` and validate emits a dangling-sha issue;
`plan changes` rolls up; a dirty tree yields a `pending` entry with untracked names.

**Do NOT port:** donor `getGitLog`/`getFilesChanged` (unguarded shell);
`parseHunks` verbatim (reuse `code-snippet.ts` range parsing); the `gh pr view` network call
as a hard dependency; doc-range splice/rebase (belongs to PORT-09); `read-file-safe.ts`/
`project-workspace.ts` as new modules.

---

## Corrections to the earlier audit

1. **PORT-08 acceptance line is wrong.** The roadmap's acceptance clause "dirty read-only
   change shows the receipt snapshot"
   ([porting-roadmap.md](./porting-roadmap.md#port-08--additive-lightweight-changes-ledger-indexed-to-receipts), previously line 226)
   **does not exist in the donor**: `pending` entries store diffstat + untracked names, and
   `task changes` never joins a receipt. It is **new work, not a port** — either drop it or
   scope it as a distinct new item.
2. **Ledger under-described.** The technical report said the ledger stores "diffstat + hunk
   headers" (previously §3.4/line ~138) — it also stores patchId, subject/author/authoredAt,
   `pr`, untracked, and computes `reachable` on read. Corrected in
   [technical-report.md](./technical-report.md#34-reporting--evidence-model-c).
3. **patchId overstated.** The roadmap called patchId "rebase-stable" but did not note it is
   **unused for matching** — "dangling SHAs handled gracefully" overstates *resolution*.
4. **Prefix/quote pinning unspecified.** D3 flags prefix fragility, but the plan never
   specified pinning `noprefix`/`mnemonicPrefix` nor reusing the target quote normalization.
5. **Minimal slice not decomposed.** The "single largest donor-only surface / L blob" framing
   is replaced by the A.11 decomposition; the promote path is a bounded, separable slice.
6. **Alias collision unflagged.** The earlier report's `doc update` mention did not flag that
   porting the donor `doc` group **shadows** ARCS's existing `doc update` alias
   (target `src/cli/commands/dependency.ts:190`) — the sharpest migration hazard.
7. **D4 stands.** The donor promotion claim is read-check-append across two lock scopes;
   convergence, not exactly-once. Correct as written.
8. **Path-containment note.** FileRef redaction/containment stays lexical (no `realpath`) if
   donor doc code is reused — see [technical-report.md §5.1 T5](./technical-report.md#51-target-side).

## Not inspected (explicit)

Donor `console-read.ts`/`console-server.ts` ledger projections; donor `remember.ts`/`status.ts`
ledger use; donor `graph-cache.ts`; `test/integration/done-ledger.test.ts` beyond grep; donor
`plan-store.createPlan` collision handling under concurrent duplicate ids; donor
`scripts/build-opencode-bundle.mjs` prompt→bundle regeneration; donor graph-builder doc-node
wiring; `src/workflow/doc-turn/*.ts` bodies; ARCS `src/web-server/run-diff.ts`, `dist/**`, and
web receipt bodies. Some `doc.ts` refusal line numbers are approximate (read via line-windows).
