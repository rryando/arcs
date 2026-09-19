# cc-arcs → arcs verification ledger (DRAFT)

Exact observed evidence, captured 2026-09-19 (UTC) during a read-only audit. This file
is the **durable home** for results that were originally produced in ephemeral scratch
directories; the scratch paths are retained only as provenance pointers. Companion to
[README.md](./README.md). Status: **DRAFT / pending approval**.

## 1. Environment baseline

| item | value |
|---|---|
| Platform | Linux x86_64 (Omarchy) |
| node | v25.2.1 |
| npm / npx | 11.16.0 |
| Target | `/home/rryando/Work/arcs` `@rryando/arcs` 5.2.3, HEAD `a9e7e1bddb405aad1d2e9d70420b525f76b3cec1`, root `ca04f0f4ab87936c76b49cfbaaf0eebf32e23b2a`, 348 commits |
| Donor | `/home/rryando/Work/agent/cc-arcs` `@traveloka/cc-arcs` 0.9.0, HEAD `b9c9f6380db9f823111e75415bf124bf34a10e02`, root `d9b8427c84149bd666a5b86f7e45467deabcdbd1` ("initial commit — CC-ARCS, rebranded fork of arcs"), 66 commits |

Target is a **live dirty worktree**: **23 modified tracked files** at audit close
(observed growing from **10** at the initial gate run ~01:12–01:13 UTC). Findings describe
the working-tree state at the relevant capture time, not an immutable HEAD; the initial
gates do not validate the final 23-file state.

## 2. Target quality gates (executed read-only)

**Who did what:** the **release worker executed** these commands; the **documentation
owner inspected the worker logs** and reproduced counts/git state — the documentation
owner did **not** re-run the gates.

**Timing/snapshot caveat (critical):** the three initial gates ran at **~01:12–01:13 UTC
while the worktree had ~10 modified tracked files**; the worktree later grew to **23
modified files**. Those three gates were **not re-run** after later edits and therefore do
**not** validate the final 23-file state. `lint-bundle` and the web typecheck were **later,
separate** checks (separate rows below). Logs were ephemeral scratch
(`/tmp/arcs-cc-audit-release-20260919/`) and their content is captured here.

| Command | When | Worktree snapshot | Result | Captured output |
|---|---|---|---|---|
| `npm test` (`vitest run`) | ~01:12–01:13 UTC | ~10 dirty files | **115 test files passed; 1668 passed, 1 skipped; 63.93s; exit 0** | `Test Files 115 passed (115)` / `Tests 1668 passed \| 1 skipped (1669)` |
| `npm run typecheck` (`tsc --noEmit`) | ~01:12–01:13 UTC | ~10 dirty files | **exit 0** | no diagnostics |
| `npm run lint` (`biome check src/ test/ web/`) | ~01:12–01:13 UTC | ~10 dirty files | **exit 0** | `Checked 295 files in 312ms. No fixes applied.` |
| `node scripts/lint-bundle.mjs` | later (~01:18 UTC) | later state | **exit 0** | `{"issues":[],"summary":{"errors":0,"warnings":0}}` |
| `npm --workspace @arcs/web run typecheck` | later (~01:18 UTC) | later state | **exit 0** | `@arcs/web@0.1.0 typecheck` → `tsc --noEmit` |

**Scope caveats:** bundle lint ran against the **existing** `opencode/arcs/` bundle;
**no rebuild** (`build`/`build:web`/prepack) was executed. The three initial gates ran at
the ~10-dirty-file snapshot (see caveat above) and are **not** a final-state validation.
Donor quality gates were **not run** (absent `node_modules`/`dist`; no-install constraint).

## 3. Donor quality gates

**Not run.** The donor has no `node_modules` and no `dist/`; installing/building was
prohibited. The donor being unindexed is **not** the reason — the absent dependencies
and dist are. Donor inventory: **129 root `test/*.test.ts` + 7 `test/integration/*.test.ts`
= 136 recursive** (the `136 + 7` figure is a pathspec-wildcard double-count; target is 115).

## 4. CLI extraction verification

- Static extractor resolved all top-level `const XParams`/spread declarations:
  **0 unresolved declarations**, 0 dynamic `path:` values, 0 duplicate paths.
- Target runtime discovery `node scripts/arcs-cli.mjs --commands --json` → **81**
  registry commands (= static count).
- Donor runtime not measured; donor static **83**.
- Union **95**; shared **69** (34 same declaration + 35 changed: 13 params/description,
  22 `supportsDryRun`-only); target-only **12**; donor-only **14**.
- Durable machine-readable copy: [cli-compatibility-matrix.json](./cli-compatibility-matrix.json) (95 rows).

### 4.1 Help / entry-point behavior (executed)

| Command | Result |
|---|---|
| `node scripts/arcs-cli.mjs --help` | **exit 0**, prints `Usage: arcs <command> [args]` + short static command list (public wrapper; minimal) |
| `node dist/index.js --help` | **exit 1**, prints `Unknown command. Run \`arcs --help\` for usage.` |
| `node dist/index.js --version` | **exit 1**, same "Unknown command." |
| `node scripts/arcs-cli.mjs task --json list arcs` | **exit 0**, returns the task list (interleaved flags work via the legacy fallback) |

**Interpretation:** the target has a minimal **static** general help in the public
wrapper; the internal entry is inconsistent (no help/version). Do not state that the
target has no general help, and do not state that interleaved routing universally fails.

### 4.2 `--dry-run` executes mutations on target (executed, isolated)

Isolated `ARCS_DATA_DIR` (ephemeral repro dir; do not treat the path as durable):

```sh
ARCS_DATA_DIR=<isolated> node dist/index.js done demo T1 --dry-run
#   BEFORE status: in_progress
#   ✓ Done: demo task   (exit 0)
#   AFTER  status: done   (updatedAt bumped)

ARCS_DATA_DIR=<isolated> node dist/index.js remember demo "hello dry run" --dry-run
#   created projects/demo/knowledge/index.json, hello-dry-run.md, hello-dry-run.meta.json
```

**Verified:** the repro data dir contains `projects/demo/tasks/index.json` with
`"status": "done"` and the three knowledge files. This is an **executed-mutation
defect**, not a missing declaration. `batch` is **static-only confirmed** (handler
`_flags` unused; unconditional `updateTask`/`createKnowledgeEntry`).

## 5. Independent reviewer verdicts (supersede worker wording)

| # | Claim | Verdict |
|---|---|---|
| 1 | Target `--dry-run` reaches mutating handlers; donor refuses centrally | **reproduced** (target); confirmed-static (donor) |
| 2 | "`worktree validate` must pass or `done` is blocked" | **confirmed-static: policy text only**; `done` never invokes validate |
| 3 | Receipt `.json`+`.diff` non-atomic | **confirmed-static, guarantee narrowed**: two `writeFileSync`; pointer written **after** → no fresh dangling pointer; `writeFilesTransaction` = best-effort rollback, **not** crash-atomic; guarantee = **write-ordering** |
| 4 | `isChunkStale` has no production callers | **confirmed-static** (only tests) |
| 5 | Donor idempotency check/claim race | **qualified**: crash-repair convergence for single-process; `findEntry`→append `started` not atomic under concurrent duplicate `promote`. **Not** claimed exact-once |
| 6 | `taskMetaSchema` omits live fields but is unused on reads | **confirmed-static, latent** |
| 7 | Containment lexical in both readers; symlinks escape | **confirmed-static, qualified**: both lexical (no `realpath`); anchor reader persists a **range**, snippet reader persists **content**; fixing `isInside` alone does not cover the anchor reader |
| 8 | Donor `getGitLog --since` shell interpolation | **qualified**: legacy path unvalidated; ledger path guarded |
| 9 | Donor runner allowlists are scope, not OS sandbox | **unresolved** (not executed; no deps/dist) |
| 10 | License metadata divergence | **confirmed-static** (rights review, not a proven violation) |

**Refuted worker overclaims (do not repeat):** "cherry-pick impossible" and "zero shared
objects" are false. The donor root is a reinitialized snapshot; a missing foreign commit
only means its objects were not imported into this clone, and cherry-pick does not
require shared ancestry. The accurate statement is **zero shared reachable commit IDs**
plus content-identical blobs (blob SHAs are content-addressed). Selective reimplementation
is recommended for semantic/rebranding reasons, **not** Git impossibility.

## 6. Git / ancestry observations

- `git rev-list --max-parents=0 HEAD` target → `ca04f0f4…`; donor → `d9b8427c…`.
- Zero shared reachable commit IDs (main: `comm` of both `git rev-list HEAD`).
- Content similarity: release worker measured 42 byte-identical tracked files
  (193 shared paths); similarity peaks near target `3.9.0–3.9.2` (late July 2026).
- `git cat-file -t <donor-sha>` in target → `could not get object info` (commit object
  not present in this clone; **not** evidence of zero shared objects).

## 7. Provenance pointers (ephemeral, not durable)

Original scratch locations, retained only to explain where numbers originated:
`/tmp/arcs-cc-audit-handoff-nhxm7r0n/` (worker handoffs), `/tmp/arcs-cc-audit-release-20260919/`
(gate logs, blob lists, worktree hashes), `/tmp/arcs-cc-audit-cli-{extract,build-matrix}.mjs`
+ `/tmp/arcs-cc-audit-cli-matrix.json` (CLI extractor), `/tmp/arcs-repro-279349` (dry-run repro).
These are **not** stable citations; the durable results are the sections above.

## 8. Proposal registration (created this pass)

| item | value |
|---|---|
| slug | `arcs` |
| id | `port-targeted-cc-arcs-improvements-into-arcs-selective-reimplementation` |
| status | **pending / unapproved** |
| data-dir path | `projects/arcs/proposals/port-targeted-cc-arcs-improvements-into-arcs-selective-reimplementation.proposal.md` |
| create call | `arcs proposal-doc create arcs "Port targeted cc-arcs improvements into arcs (selective reimplementation)" --body-file=<body>` |
| retrieval check | `arcs proposal-doc get arcs <id>` → `status:"pending"`, body non-empty |
| promote | **not run** (dry-run only, confirms it *would* promote) |

## 9. Not-run checks (explicit)

- Donor test/typecheck/lint/build; donor runtime command discovery.
- Target `build`/`build:web`/prepack; CI/release workflows; Node-20 floor on either repo.
- Fork doc-turn runner allowlists (reviewer #9) and any live HTTP probe.
- No source file was modified; no DAG/knowledge/task/plan/diagram/deploy/Git mutation
  was performed by the documentation owner.
