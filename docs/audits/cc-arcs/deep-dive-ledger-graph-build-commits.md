# Deep dive: ledger, graph and build/release commits (DRAFT)

Companion to [README.md](./README.md) and to
[deep-dive-doc-to-plan-and-diff-tools.md](./deep-dive-doc-to-plan-and-diff-tools.md).
Status: **DRAFT / pending approval.** Documentation-only: no target source, build, test,
release workflow, `npm pack` or Git mutation was performed.

This pass takes two source-cited, commit-level assessments
(`/tmp/arcs-cc-audit-handoff-nhxm7r0n/ledger-graph-commits.md` and
`.../build-release-commits.md`) as **evidence candidates**, re-checks the load-bearing
anchors against the donor (`/home/rryando/Work/agent/cc-arcs`, `b9c9f63`) and the target
(`/home/rryando/Work/arcs`), and records the resulting adoption decisions. Where this file
disagrees with the earlier [technical report](./technical-report.md) or
[roadmap](./porting-roadmap.md), **this deep dive governs** and the earlier text is patched
with an **[X]** correction.

Confidence tags are the [README legend](./README.md#evidence-provenance-and-confidence-legend):
**[C]** static code-anchored, **[E]** executed, **[I]** inferred, **[U]** unresolved,
**[X]** correction. **`jev_*` tools are `unavailable` (`no_api_key`)** — no probabilistic
verdict exists; every judgment below is manual and source-backed. The assessments did **not**
run any donor test/build/release/`npm pack`; their claims are **static-only [C]**.

## Commit inventory

| Commit | PR | Surface | One-line |
|---|---|---|---|
| `f3861a3` | #83 | ledger + graph + brief | appended change ledger (`commit\|pending\|pr\|tombstone`), `task brief`, `validate --checks=changes,citations`, `task_cites_doc`/`task_changed_file` edges |
| `5124228` | #45 | graph + docs | `doc` node, `plan_derives_from_doc`(1.0)/`doc_spawns_plan`(0.8), `doc-store.ts`, `validate --checks=doc-health` |
| `264150a` | #52 | build | rename `opencode/cc-arcs`→`bundle/cc-arcs`; filesystem-declared skills walk; `hosts:` frontmatter |
| `a18c0bd` | #60 | build | owner-nested dirs `skills/<owner>/<name>` + agent mirrors `agents/<owner>/<stem>.md`; owner lint |
| `9c7df6d` | #47 | build | CLI-first prompt fragments; **untracks** the 12 prompt mirrors; `generate:bundle` on `pretest` |
| `5017322` | #77 | build | Pi extensions catalogue + `build-pi-extensions-bundle.mjs` (manual snapshot of live `~/.pi/agent`) |
| `d0ba884` | #82 | build | deploy catalogue as one owned `~/.pi/agent/cc-arcs/` package; ownership preflight + tracked revert |
| `939ddfc` | #54 | release | replaces the whole chain with one tag-triggered release job |
| `e8e36b6` | #67 | cli | `--version` through `src/cli/index.ts` |
| `98cf022` | #80 | config | `migrateLegacyConfig()` before validation + non-exiting `tryReadConfig()` |
| `36996f5` | #61 | build | auto-init bootstrap; retire repo-root `skills/`; strip generated banner at all deploy write points |
| `c3ec9df` `7a3109c` `a00c672` `7f0d017` `1536b08` `24d331f` | #28,#29,#31,#32,#33,#37 | release (retired) | the multi-hop release chain that pushed a bump commit to a protected `main` |
| `ba85b11` | #2 | setup | codegraph/Hermes/presetup wiring (+ postinstall) — assessed with the ledger wave |
| `b4e3507` | #75 | web | console revamp; graph shell only (no server graph change) |

---

## Part A — LEDGERS (`f3861a3`, #83)

### A.1 What the commit adds

A new append-only ledger at `<projectDir>/workflow/changes.jsonl`
(donor `src/workflow/change-ledger.ts`, 305 L; `changes.ts` +372, `utility.ts` +141,
`task.ts` +87, `status.ts` +31, graph ±57, web graph +~1.6 kL). Intent: make "what a task
changed" a **deterministic, git-derived, LLM-free** record, and let design→task provenance
travel across the promotion hop. Craft is high: append-only, lock-guarded, no patch bodies,
`reachable` never stored, exhaustive skip reasons.

### A.2 Data model — entry kinds, stored vs recomputed [C]

`ChangeKind = commit | pending | pr | tombstone` (donor `change-ledger.ts:33`).
`ChangeEntry` (donor `change-ledger.ts:38-67`):

- **`commit`** — `sha`, `subject`, `author`, `authoredAt`, `patchId`, and per-file
  `{path, additions, deletions, hunks[]}` where `hunks` are `@@` **header strings only**.
- **`pending`** — worktree diffstat (`hunks:[]`) + untracked **names**; git cannot
  reconstruct it later.
- **`pr`** — `{url, headSha?, state?}` from `gh pr view --json headRefOid,state`
  (donor `changes.ts:56-75`); optional, degrades to URL only.
- **`tombstone`** — `{taskId, sha}` retraction (donor `removeChange` `change-ledger.ts:162-169`).

**Stored:** `taskId, planId?, sha?, patchId?, subject?, author?, authoredAt?, files[], untracked?, pr?, recordedBy, at`.
**Recomputed on read:** `reachable` via `git merge-base --is-ancestor <sha> HEAD`, only when
`cwd` is passed (donor `change-ledger.ts:145-147`) — **never stored**. `readChanges`
(donor `change-ledger.ts:111-160`) applies tombstones, `(taskId,sha)` dedup and
pending-supersession. **No patch body is ever stored**; `changes.ts` re-renders it via
`getCommitPatch` only while a sha is reachable.

### A.3 Hooks into the task lifecycle [C]

- **`task transition … in_progress`** stamps a baseline at donor `task.ts:323` — the direct
  analogue of ARCS `TaskMeta.startHead`.
- **`done`** calls `recordTaskLedger` (donor `done.ts:81,222`) → `recordCommits` /
  `recordPending` (`:109,126`), recording `baseline..HEAD` plus a `pending` entry for a dirty
  tree; narrowing by `sourceFiles` (`onlyTouching`) happens only when another task is open.
  `recordCommits` (donor `change-ledger.ts:208-257`) is the **single write path** shared by
  `done` and `record-change`.

### A.4 `validate --checks=changes` [C]

`changes` (donor `utility.ts:569-700`): `done_without_ledger`, `dangling_change_sha`
(`reachable=false`), `pending_worktree_change`, `dangling_knowledge_commit`. `citations`:
`unresolved_doc_ref`, `uncited_design`.

### A.5 ARCS comparison [C]

ARCS already has `captureReceipt` (`src/utils/run-report.ts:61-96,341`): a base/head
**committed range or snapshot**, `dirty`, `untracked` names, and a **capped unified diff body**
(`RUN_REPORT_DIFF_MAX_LINES = 300`, `run-report.ts:101`) persisted as
`<slug>/reports/<id>.json` + `.diff` via two `writeFileSync` calls
(`src/utils/report-store.ts:88-89`). `TaskMeta.startHead` and `TaskMeta.report: TaskReportRef`
exist; `done --learn` mines `deriveDiffCodeRanges` → `readCodeChunk` into `CodeChunk`s
(`src/utils/code-snippet.ts:289,347`, `done.ts:deriveLearnChunks`).

### A.6 Additive vs duplicate vs conflicting

**Genuinely additive:** per-commit granularity **with hunk headers + `patchId`**; the
`tombstone` retraction verb; `pending` as a first-class task-scoped entry;
`record-change/--commits/--range/--pr/--remove`; read-side `reachable`; `plan changes`
roll-up; knowledge `commits` citation; the `changes`/`citations` validators; the
`task_changed_file` edge.

**Duplicate (do not reinvent):** `pending`'s diffstat+untracked **overlaps**
`Receipt.dirty`/`untracked`; the ledger's `files/additions/deletions` overlap
`Receipt.filesChanged/insertions/deletions`.

**Conflict-prone:** `baselineCommit` **duplicates** `startHead` — two baselines can diverge.
Donor `FileRef = {path, anchor?}` (donor `storage-utils.ts:125`) is **narrower** than ARCS's
`{path, anchor?, startLine?, endLine?}` (`src/utils/storage-utils.ts:93`); a ported ledger
path must be sanitized through ARCS `sanitizeFileRefs`.

### A.7 Hard rules (adopted invariants)

1. **Adopt the ledger keyed off ARCS `startHead`.** Never introduce `baselineCommit`.
2. **Keep receipts as the heavy, worktree-accurate store.** The ledger stores no patch body;
   it **complements** receipts (`changes.jsonl` cannot reproduce receipt capture).
3. **Never store patch bodies.** `reachable=false` is **reported, not resolved**; `patchId`
   is **advisory only, never used for matching** (dedup is by `(taskId,sha)`).
4. **Use argv git, never the donor shell helpers.** ARCS's `git.ts` is argv/timed
   (`src/utils/git.ts`); the donor ledger helpers are shell-string `execSync`
   (donor `git.ts:11-20`). Re-express as argv and pin
   `-c diff.noprefix=false -c diff.mnemonicPrefix=false` (ARCS already pins, `run-report.ts:124`)
   plus `code-snippet.ts` `normalizeDiffPath` (`:221`).
5. **Reject `gh pr view` as a hard dependency** — network + credential coupling; the ledger
   must stay offline.
6. **Close D7 by re-reading inside the lock.** Donor `recordCommits` reads the ledger
   **outside** the append lock (`change-ledger.ts:213`; `withLock` wraps only `appendChange`,
   `:83-86`), so concurrent writers duplicate `(taskId,sha)` lines. The port must read
   **inside** the lock.

### A.8 Verdicts

| Item | Verdict | Reason (ARCS invariant) |
|---|---|---|
| Ledger core (`commit` entries, hunk headers, `patchId`, `tombstone`, `record-change`, `task/plan changes`) | **ADAPT** | Additive to receipts; reimplement with argv git, keyed off `startHead` (never `baselineCommit`). |
| `pending` entry kind | **DEFER / partial REJECT** | Overlaps receipt `dirty`/`untracked`; adopt only if a task-scoped pending view is wanted beyond the receipt. |
| `baselineCommit` field | **REJECT** | Duplicates `startHead`; two baselines can diverge. |
| validate `changes` (`done_without_ledger`, `dangling_change_sha`) | **ADOPT after ledger** | Deterministic, no-LLM; fits the existing `validate` surface. |
| validate `citations` | **DEFER** | Depends on `docRefs`/docs engine ARCS lacks (PORT-09). |
| Knowledge `commits` + `dangling_knowledge_commit` | **ADAPT** | Metadata-only, CLI-only; add conservatively. |
| `gh pr view` network call | **REJECT as hard dependency** | Offline ledger invariant; network/credential coupling. |
| donor shell git helpers (`git.ts:7-17`) | **REJECT** | Shell interpolation (audit D2); ARCS uses argv. |
| Donor `FileRef` shape | **REJECT as replacement** | Narrower; would drop ARCS line ranges. |
| Donor storage primitives (plain `writeFile`) | **REJECT** | ARCS keeps transactional/atomic writers. |

---

## Part B — GRAPHS (`5124228` #45; `f3861a3` #83)

### B.1 What the commits add [C]

- **`5124228` (#45)** added the `doc` NodeType and `plan_derives_from_doc` (1.0) /
  `doc_spawns_plan` (0.8); `EDGE_WEIGHTS` went 7→9
  (`git show --format= 5124228 -- src/retrieval/graph-types.ts`). `graph-builder.ts` reads
  `readDocIndex().docs` and emits the edges from the doc's `planIds` side; `sourceHashes.docs`
  keys on `docs/index.json`. Also added `doc-store.ts` (391 L), promotion via the journaled
  `artifact-service`, and `validate --checks=doc-health`.
- **`f3861a3` (#83)** added `task_cites_doc` (1.0) and `task_changed_file` (0.85)
  (donor `graph-types.ts:66-78`).
- **`b4e3507` (#75)** is UI shell only — the console edge-family/legend work belongs to
  `f3861a3` (`git log -S"relationFamily" -- web/src/console/graph-model.ts` → `f3861a3`).

### B.2 Where each edge comes from [C]

**`task_cites_doc`** — from `task.docRefs` (donor `graph-builder.ts:177,203,209`);
docs-subsystem-derived.

**`task_changed_file`** — from `readChanges(projectDir)` grouped into `changedFilesByTask`
(donor `graph-builder.ts:187-193`), emitted at `:215-222`. It **skips paths already declared
in `sourceFiles`** and **reuses `registerFileRef`** so the existing `shares_source_file`
pairing picks them up. Ledger-derived.

**doc ↔ plan** — `graph-builder.ts:102` reads `readDocIndex` and walks each doc's `planIds`.
Docs-subsystem-derived.

### B.3 Cache invalidation [C]

`graph-cache.ts` is **byte-identical** between donor and ARCS (`diff` → `IDENTICAL`): mtime
`sourceHashes` + a 60 s `maxAge`. The donor adds `sourceHashes.docs` (does not exist in ARCS)
and, **only when the file exists**, `sourceHashes.changes` (donor `graph-builder.ts:319-337`;
`if (changesMtime > 0) sourceHashes.changes = changesMtime`). `appendChange` explicitly calls
`invalidateGraphCache` (donor `change-ledger.ts:88`). ARCS `src/retrieval/graph-builder.ts:226-237`
currently hashes only `knowledge`/`plans`/`tasks`; ARCS `graph-types.ts:30-36` `AdjacencyIndex`
carries `sourceHashes` (it is the plain `changes` key, not the doc key, that must be added).

### B.4 ARCS's current model and the gating question [C]

ARCS `graph-types.ts:5` `NodeType = "task" | "plan" | "knowledge" | "file"` (no `doc`);
`:7-14` has **7** `EdgeRelation`s (`task_belongs_to_plan`, `shares_source_file`,
`knowledge_touches_file`, `plan_contains_task`, `shares_keywords`, `project_depends_on`,
`task_blocks_task`) and no `task_changed_file`/`task_cites_doc`. ARCS has no `readDocIndex`,
no `docRefs`, no ledger.

- **`task_changed_file` depends only on the ledger** → **PORT-08-gated**, portable once the
  ledger exists; it slots into the existing `fileIndex`/`shares_source_file` machinery.
- **`task_cites_doc` + the `doc` node + doc↔plan edges depend on the docs engine** →
  **PORT-09-gated**, not portable now.

### B.5 Correction of the earlier audit grouping [X]

The earlier [technical report §4](./technical-report.md#4-feature--decision-matrix) cell
"Graph doc edges → Port doc edges with PORT-09; ledger edges only with PORT-08" reads as if
**all** new edges were docs-gated. That is **right for `task_cites_doc`/the `doc` node** but
**wrong for `task_changed_file`**, which is **ledger-derived and PORT-08-gated**. The
[roadmap PORT-10](./porting-roadmap.md#port-10--graph-doc-edges-split-docs-derived-vs-ledger-derived-x) instruction "do not add a
speculative unused `task_changed_file` union member" is also too strong: once the ledger
lands (PORT-08) the edge is neither speculative nor doc-gated. Both have been patched.

### B.6 Verdicts

| Item | Verdict | Reason (ARCS invariant) |
|---|---|---|
| `task_changed_file` edge + `sourceHashes.changes` (guard on file-exists) | **ADOPT after ledger (PORT-08)** | Pure ledger-derived; slots into existing `fileIndex`/`shares_source_file`. |
| `doc` node + `plan_derives_from_doc`/`doc_spawns_plan`/`task_cites_doc` + `sourceHashes.docs` | **DEFER (PORT-09)** | Depend on the docs subsystem ARCS does not ship. |
| `graph-cache.ts` | **No action** | Byte-identical between repos. |
| `b4e3507` console graph shell (side-reader, legend, minimap) | **REJECT** | Coupled to the donor's 168-file console; low marginal value over ARCS web. |

---

## Part C — BUILD / RELEASE

The assessed build/release commits are `264150a` (#52), `a18c0bd` (#60), `9c7df6d` (#47),
`5017322` (#77), `d0ba884` (#82), `939ddfc` (#54), plus the retired chain (`c3ec9df` #28,
`7a3109c` #29, `a00c672` #31, `7f0d017` #32, `1536b08` #33, `24d331f` #37), `e8e36b6` (#67),
`98cf022` (#80), `36996f5` (#61). All claims are **static-only [C]**; no build, release run or
`npm pack` was executed.

### C.1 Bundle layout — did the donor retire `bundle-runtime.json`? [C]

**No.** The final `bundle/cc-arcs/bundle-runtime.json` still hand-declares `agents`,
`plugin`, `preservedFiles`, `excludePatterns`, and `listDeclaredFiles()` survives in
`scripts/lib/bundle-helpers.mjs`. Only the **`skills` map** moved to a filesystem walk
(`src/utils/bundle-skills.ts`, `264150a`). `excludePatterns` becomes load-bearing via a glob
converter that **throws on unsupported shapes** rather than matching nothing. `hosts:`
frontmatter targeting **fails open**. The rename half of `264150a` is mechanical noise; its
own message documents that text search missed two split-path references
(`src/cli/bundle-installer.ts`, `test/opencode-bundle-installer.test.ts`). `a18c0bd` (#60)
adds `skills/<owner>/<name>/` and `agents/<owner>/<stem>.md` with `skill-owner-mismatch` /
`skill-directory-collision` lint (`scripts/lint-bundle.mjs:289-357`); deployed paths stay
flat-by-name, so installs don't change shape.

**Both repos therefore still keep a hand allowlist — the difference is one dimension, not two.**
ARCS is **not behind**; the donor is slightly ahead on one axis (skills) and equally
hand-maintained on the others. Switching ARCS's `lint-bundle.mjs` Check 2 from
allowlist-driven to walk-driven **weakens** the stray-file defense (any file dropped into a
skill dir auto-ships); accept only with `excludePatterns` retained and the 0/0 gate still
rejecting strays outside skill dirs.

### C.2 Uncommitted prompt mirrors (#47) [C]

`9c7df6d` adds `CC_ARCS_CLI_FIRST`/`CC_ARCS_LIFECYCLE_MAP` fragments, then **untracks** the
12 generated prompt mirrors, adds `generate:bundle` on `pretest`/`pretest:integration`, and
repoints 19 tests. No `.npmignore` → npm falls back to `.gitignore`, so `files[]`
whitelisting had to be proven via `npm pack --dry-run` to keep shipping the mirrors.

**ARCS's model is stronger; keep it.** ARCS commits its three generated mirrors
(`opencode/arcs/prompts/arcs-{orchestrate,orchestrate-caveman,flash}.txt`, `git ls-files`)
**and** byte-compares them to source in `test/prompt-parity.test.ts`
(`stripBanner(body) === ORCHESTRATE_PROMPT_TEXT + "\n"`). The donor's `pretest`
regeneration **silently fixes** drift; ARCS's parity test **fails** on drift **and** keeps the
mirror reviewable in the PR diff.

### C.3 Pi extensions catalogue (#77/#82) [C]

`src/cli/pi-extensions.ts` is the SSOT; `scripts/build-pi-extensions-bundle.mjs` is a
**manual** snapshot from a maintainer's live `~/.pi/agent`; the module doc itself says wiring
it into `generate:bundle` would "fail or silently snapshot nothing". `d0ba884` (#82) deploys
the catalogue as one owned `~/.pi/agent/cc-arcs/` package with a strict preflight parse of all
shared JSON before any write (donor `scripts/deploy-pi-bundle.mjs:355-361`),
`preflightPiPackageRoot` refusing to sync into a `cc-arcs/` we did not create (`:379-393`),
and `mergeFragmentTracked`/`revertMergedEntries` recording exactly what was added so deselect
reverts precisely (`:405-441`).

**Reject the catalogue:** (a) the snapshot source is a live machine and is deliberately
excluded from `generate:bundle` — ARCS CI cannot rebuild it (reproducible-build invariant);
(b) it vendors host-internal forks (tvlk-provider/litellm, a `pi-subagents` fork) — violates
"no host-specific coupling". ARCS ships one `web/extensions/arcs-sidebar.ts`.

**But adapt the discipline:** ARCS's `scripts/deploy-pi-bundle.mjs` already skips a
user-modified extension (`extensionSkipped: "user-modified"`) but has **no**
preflight-parse-before-write and **no** tracked revert for its `settings.json` model merge.

### C.4 The release-chain lesson (#28→#54) [C]

Chain history: `c3ec9df` (#28) two-workflow gate → `7a3109c` (#29) collapsed to one workflow
the same day → `a00c672` (#31) legacy tag baseline → `7f0d017` (#32) derive versions from
history → `1536b08` (#33) rename to `release-from-main.yml` → `24d331f` (#37) restored
`prepare-release`/`publish-release` because `release-from-main` pushed the bump commit
straight to a **protected main** (`main requires an approving review with no auto-merge and
no admin bypass`), so **five releases landed a tag with no matching main commit**, compounded
by a `tag_exists()` `if/fi`-with-no-`else` exit-code bug → `939ddfc` (#54) replaced everything
with one tag-triggered job.

**The lesson, four parts:**

1. Every hop (trigger type, cross-job dependency, `pull_request:closed` handoff) is an
   independent failure surface; the E404 was the *fourth* hop deep.
2. **Never push a version-bump commit to a protected branch from CI.** Tag a reviewed commit.
3. A shell `if` without `else` swallows exit codes — use `set -euo pipefail`
   (donor final `release.yml:55,83,93`).
4. Make every irreversible step idempotent: `npm view "$pkg@$v"` guard before publish
   (`:83-84`) and `gh release view` before `gh release create` (`:93-96`).

**ARCS's `release.yml` carries hazards (2) and (4).** It is manual `workflow_dispatch`
(`:3`) → `npm version` (`:76`) → `git push --follow-tags origin HEAD:${{ github.ref_name }}`
(`:96`) → `npm publish` (`:89`). It pushes the bump commit to `main` from CI, publish is
**non-idempotent** (a re-run bumps again), and there is **no `tag == version` gate**. (The
donor's own caveat: its CI is Node 22 but `release.yml:39` pins Node 20; ARCS is uniformly
24.)

### C.5 Postinstall survivability (#80) [C]

Root cause: `readConfig()` answered a schema failure with `process.exit(1)` — *not* an
exception — bypassing every `try/catch` and failing `npm i -g` at postinstall. Durable
pattern: **migrate-before-validate + a non-exiting read**. `98cf022` adds
`migrateLegacyConfig()` before validation (donor `src/cli/config.ts:219-240`) and a
non-exiting `tryReadConfig()` (`:255`), keeping the exiting `readConfig()` (`:274-280`) for
interactive paths.

**ARCS has the same shape.** `src/cli/config.ts:54-63` runs `cliConfigSchema.safeParse` and
on failure `console.error` + `process.exit(1)`. ARCS has no postinstall, but `arcs init` /
`arcs config` die on the same file. ARCS already has `readConfigOrDefault()`
(`config.ts:72-77`), but it **discards** invalid config — weaker than migrate-then-validate
(it silently throws away the user's valid keys).

### C.6 Verdicts

| # | Item | Verdict | Reason (ARCS invariant) |
|---|---|---|---|
| 1 | Filesystem-declared skills (only the `skills` map) | **ADOPT** | Removes a ~62-line hand map; keep lint 0/0 + `excludePatterns` as the stray guard. |
| 2 | `bundle/` rename | **DEFER** | Cosmetic; hidden split-path refs = real risk; no behavior gain. |
| 3 | Owner-nested dirs (#60) | **DEFER** | ARCS has a single skill owner; collision checks need ≥2 owners. |
| 4 | Uncommitted prompt mirrors (#47) | **REJECT** | ARCS's `test/prompt-parity.test.ts` beats regenerate-on-pretest; published-package invariant holds. |
| 5 | Pi extensions catalogue + snapshot (#77) | **REJECT** | Snapshot is not CI-reproducible; violates "no host-specific coupling". |
| 6 | Pi ownership/state/revert discipline (#82) | **ADAPT** | One sidebar still writes shared `settings.json` without preflight/revert. |
| 7 | `tag == version` gate | **ADOPT** | Pure release safety; no invariant conflict. |
| 8 | Idempotent publish + `gh release` guards | **ADOPT** | Idempotency required by the published-npm-package invariant. |
| 9 | Auto tag-triggered release | **REJECT** | ARCS release is deliberately manual; external side effect, not git-revertible. |
| 10 | Bump-commit push to `main` from CI | **REJECT** | Exactly the #37 protected-main failure (`release.yml:96`). |
| 11 | Migration-before-validate + `tryReadConfig` (#80) | **ADOPT** | ARCS `readConfig` still `process.exit(1)` at `config.ts:63`. |
| 12 | Retired-chain release-shape test | **ADOPT** | ARCS `test/workflow-policy.test.ts` tests domain policy, not release shape. |
| 13 | `36996f5` (#61) generated-banner strip at deploy write points | **ADAPT** | Keep the banner strip; ARCS retires neither repo-root `skills/` nor adds the bootstrap unconditionally. |
| 14 | Donor plain-`writeFile` storage / Node 20-vs-22 mismatch / `@traveloka` restricted publish | **REJECT** | ARCS has atomic writes, uniform Node 24, public `@rryando/arcs`. |

---

## Corrections produced by this pass

1. **[X] `technical-report.md:166`** called `files`→`bundle/` "209 tracked generated files".
   `git ls-files bundle` = 209, but `git ls-files bundle/cc-arcs/agents` = **0** (the prompt
   mirrors are gitignored). The 209 are **authored** inputs; the **bundle is the source of
   truth**, not generated output. Corrected in [technical-report §3.6](./technical-report.md#36-releasebuild-c).
2. **[X] `technical-report.md:129`** said "a 16-entry Pi extensions catalogue".
   `src/cli/pi-extensions.ts` declares **17** ids; 16 vendored dirs exist
   (`pi-mcp-adapter` vendors nothing). Corrected in [§3.3](./technical-report.md#33-donor-delegation-chain-c).
3. **[X] §4 matrix** — `task_changed_file` must move **out** of "doc edges / PORT-09" and is
   **ledger-gated (PORT-08)**. Corrected in [§4](./technical-report.md#4-feature--decision-matrix).
4. **[X] §3.6 / release** — record the retired-chain lesson and that ARCS's own
   `release.yml:96` pushes a bump commit to `main` from CI (the same hazard). Corrected in
   [§3.6](./technical-report.md#36-releasebuild-c).
5. **[X] static-only release claims** — the audit never ran a build/release workflow/`npm pack`;
   its release claims are static. Noted in [§2.1](./technical-report.md#21-audited-vs-uninspected-boundary-audit-all-interpretation)
   and §7.

## Not inspected (explicit)

Donor `console-read.ts`/`console-server.ts` ledger projections; donor `remember.ts`/`status.ts`
bodies (only the `status.ts` ledger-counter hunk of `f3861a3`); donor
`artifact-service.ts`/`journal.ts`/`doc-store.ts` internals beyond the `5124228` diff;
donor `setup.ts`/`setup-codegraph.ts` bodies; donor web graph components beyond
`graph-model.ts:relationFamily` and stat lines; donor `bundle/cc-arcs/pi-extensions/**`
contents; donor test suites; ARCS `web-server` run-diff/receipt routes; `dist/**`. No donor
build/test/release was executed.

## Verify

- `cd /home/rryando/Work/agent/cc-arcs && git show --format= 5124228 -- src/retrieval/graph-types.ts`
  → adds the `doc` node and `plan_derives_from_doc`(1.0)/`doc_spawns_plan`(0.8);
  `git log -S"relationFamily" -- web/src/console/graph-model.ts` → only `f3861a3`.
- `diff` of donor vs ARCS `src/retrieval/graph-cache.ts` → `IDENTICAL`.
- Donor `git ls-files bundle` = 209 / `git ls-files bundle/cc-arcs/agents` = 0; 16
  `bundle/cc-arcs/pi-extensions/*/` dirs vs 17 declared ids.
- ARCS `src/retrieval/graph-types.ts` (7 relations, 4 node types) and
  `src/retrieval/graph-builder.ts:226-237` (3 `sourceHashes`) read directly; ARCS
  `release.yml:3,76,89,96` read directly. `git status`/`git log` show a clean tree.
- **Not run:** donor test suite, any build/release/`npm pack`, `jev_*` (`unavailable`).
