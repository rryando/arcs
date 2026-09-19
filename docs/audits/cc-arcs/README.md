# cc-arcs → arcs port assessment (DRAFT)

**Status: DRAFT / pending human approval.** This is a read-only audit and a draft
porting roadmap. Nothing here is approved for implementation. The audit made **no
changes to target implementation source** and **no changes to existing ARCS project
records** (tasks, plans, diagrams, knowledge); it added **new documentation only** and
one **pending** proposal-doc. The only mutations the audit performed were inside an
**isolated fixture data dir** while reproducing the dry-run defect.

| | |
|---|---|
| Assessed target | `/home/rryando/Work/arcs` (`@rryando/arcs` 5.2.3), HEAD `a9e7e1bddb405aad1d2e9d70420b525f76b3cec1` |
| Donor | `/home/rryando/Work/agent/cc-arcs` (`@traveloka/cc-arcs` 0.9.0), HEAD `b9c9f6380db9f823111e75415bf124bf34a10e02` |
| Target ancestry root | `ca04f0f4ab87936c76b49cfbaaf0eebf32e23b2a` (348 commits) |
| Donor ancestry root | `d9b8427c84149bd666a5b86f7e45467deabcdbd1` — `chore: initial commit — CC-ARCS, rebranded fork of arcs` (66 commits) |
| Audit date | 2026-09-19 |
| Companion proposal | see [Proposal registration](#proposal-registration) below (ARCS proposal-doc, pending) |

## What this package is

Several read-only specialist audits plus a CLI compatibility extraction were run
against the donor and target, then synthesized here into durable repo documents.
"Audit all" here means **inventory every major surface with deeper risk paths**
(CLI, delegation, reporting/evidence, domain/storage, web+security, release/CI),
**not** line-by-line proof of correctness; several surfaces were inspected only
partially and at high-risk paths. Each document states its audited vs. uninspected
boundary explicitly, and marks partial vs. exhaustive coverage.

### Navigation

| Document | Contents |
|---|---|
| [technical-report.md](./technical-report.md) | Deep source-linked technical evaluation: revision/worktree caveats, architecture maps, feature & decision matrix, severity+confidence findings, boundaries, open questions |
| [cli-compatibility-inventory.md](./cli-compatibility-inventory.md) | Complete 95-row union of target vs donor CLI commands, params deltas, parser/router aliases, batch op namespace |
| [cli-compatibility-matrix.json](./cli-compatibility-matrix.json) | Machine-readable matrix backing the inventory (same 95 rows + summaries) |
| [porting-roadmap.md](./porting-roadmap.md) | Phased DRAFT outcome tasks (P0–P4 + deferred/rejected), exact dependency edges, likely paths, scoped verification, rollback, S/M/L estimates (estimates), decision gates |
| [verification.md](./verification.md) | Exact observed evidence ledger: commands, exit codes, log contents, timestamps, snapshots |

### Evidence provenance and confidence legend

Source anchors were produced read-only by specialist workers (ephemeral handoff
scratch; conclusions summarized durably here and reproduced in
[verification.md](./verification.md)) plus a static CLI extractor. **Who did what:**
the **release worker executed** the target test/lint/typecheck and bundle-lint
commands; the **independent reviewer executed** the isolated dry-run reproduction;
the **documentation owner inspected the worker logs** and reproduced the
deterministic counts and git state — the documentation owner did **not** re-run the
gates. Line-level anchors below have **not** all been re-read by the documentation
owner and are marked by provenance.

Confidence tags used throughout:

- **[C] Confirmed (static, code-anchored)** — a `file:line` fact read from source; **no runtime execution**.
- **[E] Executed** — reproduced by a command actually run (runtime observation); the command and result are in [verification.md](./verification.md).
- **[I] Inferred** — reasoned from code/comments but not executed or reproduced; may be wrong.
- **[U] Unresolved / not independently verified** — the reviewer did not settle this claim; treat as provisional.
- **[X] Correction** — a worker overclaim explicitly corrected before persistence (see next section).

A reproduced runtime defect must be tagged **[E]** and backed by an executed command
in [verification.md](./verification.md).

## Executive decision (decision-ready)

Target and donor share **content-similar files**, with similarity peaking near
target `3.9.x` (late July 2026); this fork point is a **content-similarity estimate,
not a proved common base** (no shared reachable commit IDs). They then diverged ~7
weeks, in **both** directions. Neither is an upgrade of the other. Cross-repo
porting is therefore a sequence of **selective reimplementations**, not a merge or a
wholesale adoption.

**Recommended (approve individually, in this order):**

- **P0 — preserve invariants first.** Before importing anything, freeze and
  re-assert the target invariants the donor lacks: `ARCS_GUARDED` write-gate +
  `--token`, plan-scoped worktree registry, receipt/chunk evidence capture, the
  target's richer zod schemas, and the full test contract. Include a **conditional
  pre-copy rights review** for any adapted donor file. Do not trade these away.
- **P1 — parser/central dry-run + schema/SSOT/path parity.** The target's global
  `--dry-run` is not inert: an isolated reproduction (**[E]**) showed `done --dry-run`
  actually transitioned a task and `remember --dry-run` actually created knowledge
  files. Adopt the donor's central `refusesDryRun` predicate and parser hardening
  **without dropping `--token`**; complete `taskMetaSchema`; add a shared
  sub-agent **prompt SSOT**; route config reads through a non-`process.exit`
  `tryReadConfig`; add a safe **realpath/path-containment policy**. Effort:
  **S–M (estimate)**.
- **P2 — task brief + evidence durability.** Add `task brief` reusing existing
  task/retrieval/receipt data **without** importing the full docs engine; harden
  receipt write-ordering/diagnostics and surface chunk staleness; add an
  **additive, lightweight task changes ledger indexed to receipts**. Effort:
  **M (estimate)**.
- **P3 — optional generalized docs + pinned citations.** The donor's `doc`
  subsystem (tech-doc/design-doc lifecycle, `doc promote`) is the single largest
  donor-only surface. Port only as an **opt-in** capability with a migration +
  locking design and graph edges. Effort: **L (estimate)**.
- **P4 — selective security caps and release safety.** Opt-in least-privilege
  runner modes, request body-size cap, Mermaid default-safety. Release **safety
  gates** (tag==version, simulated publish) may be adopted; **auto tag-trigger +
  auto postinstall/global writes remain deferred**. Effort: **S–M (estimate)**.

**Defer until specifically approved:** whole-console rewrite (donor's 168-file
console), vendored Pi agent runtime, automatic postinstall/global config writes,
destructive cascades, doc-turn section-authoring runtime, optional richer-HTML
rendering, donor cross-project listing helper.

**Reject:** donor removal of the guard/worktree/receipt/chunk features; narrower
schemas; raw direct storage writes; corporate provider defaults
(`tvlk-provider`/litellm, hermes/knowledge-MCP URLs, host-personal layout
presets); revival of retired roles while target's own gates forbid them;
reintroduction of MCP transport (target is intentionally CLI-only with
multi-adapter deploy).

**Preserve:** CLI-only + multi-adapter (opencode / claude-code / pi), the
dependency-honest DAG, evidence-linked knowledge/receipts, and `ARCS_GUARDED`.

## Corrections applied (worker overclaims overridden before persistence)

1. **Git ancestry.** The two repos have **zero shared reachable commit IDs**
   (main: `comm` of both `git rev-list HEAD`). This does **not** mean "zero
   shared objects": identical tracked files are content-addressed, so some blob
   hashes coincide. Cherry-pick is **not impossible** — it would require
   importing the donor's objects into the target's object store first, since the
   commit objects are absent from this clone. Because of pervasive rebranding and
   semantic divergence, **selective reimplementation is recommended**, not patch
   application.
2. **Licensing.** Target `package.json` declares MIT but ships **no tracked
   LICENSE file**; the donor declares/shows a **different** license (ISC text with
   a Traveloka copyright). The "relicensed" framing is **inferred**, not proved.
   Recommendation: complete a **conditional attribution/rights review before
   copying** any donor file. No conclusion of infringement or of illegal
   relicensing is drawn.
3. **Static declaration ≠ behavior.** CLI "changed" rows are *declaration* diffs;
   behavioral divergence is listed separately and is not fully measured. The
   reconciled count is **69 shared** (34 same declaration + 35 changed), not the
   earlier partial "65 shared" figure. Fork runtime was not executed.
4. **Fork test limitation.** The donor being unindexed is **not** why its tests
   could not run; the actual limitations are the absent `node_modules`/`dist`
   and the audit's no-install constraint.
5. **Target baseline.** Target is a **live user worktree** that grew from 10 to 23
   modified tracked files during the audit. The initial test/lint/typecheck runs
   were executed at **~01:12–01:13 UTC while ~10 files were dirty** and were **not
   re-run** after later edits; they do **not** validate the final 23-file state.
   The later bundle-lint and web typecheck were separate, later checks.
6. **Worktree validate.** The prompt sentence claiming `arcs worktree validate`
   blocks `arcs done` is **orchestrator policy text**, not a `done` runtime gate.
   The roadmap presents it as an explicit decision (enforce in CLI vs. keep
   fail-soft), not an unconditional behavior change.
7. **Write durability.** The receipt `.json`+`.diff` pair is written as two raw
   `writeFileSync` calls, but the pointer is persisted **after** them, so there is
   **no dangling pointer on a fresh write**. The achievable guarantee is
   **write-ordering, not crash-atomic multi-file update**: `writeFilesTransaction`
   is best-effort rollback on a synchronous throw, not crash-atomic. No
   "exactly-once" guarantee is claimed; the donor idempotency is described as
   **intended replay convergence**, not proven exact-once under concurrent
   duplicates (including async duplicates in one process).
8. **Path containment (reviewer-confirmed).** Containment is **lexical** in both
   readers (no `realpath`): they reject absolute paths and `..` traversal lexically
   but **do not** resolve symlink targets, so a symlink inside the workspace can
   escape. This is confirmed static, not "reviewer pending". Realpath safety is
   **not** over-promised; the fix is a deliberate policy decision (roadmap PORT-17).
9. **Runner permissions.** Least-privilege tool flags are **not** an OS sandbox;
   the donor's vendored Pi runtime fixes are unverified against the installed
   upstream, so the target is **not** labeled "exposed" merely because donor
   fixes exist. The donor runner allowlists were **not executed** (no deps/dist)
   and remain source-level (**[U]**).
10. **`--dry-run` is not inert (reviewer-executed, [E]).** With an isolated
    `ARCS_DATA_DIR`, `done <slug> <id> --dry-run` moved a task `in_progress → done`
    and `remember <slug> "..." --dry-run` created `knowledge/index.json` +
    `hello-dry-run.md`/`.meta.json`. This is an **executed-mutation defect**; `batch`
    is static-only confirmed. Treated as a P1 fix.
11. **General help is not absent.** `node scripts/arcs-cli.mjs --help` succeeds
    (exit 0) with minimal **static** usage, while internal `node dist/index.js
    --help`/`--version` exit 1. The wrapper/internal entries are inconsistent; the
    donor's help is registry-driven.
12. **Jev tools.** Every `jev_*` invocation returned `unavailable (no_api_key)`;
    not every worker invoked them. No probabilistic verdict exists, so all
    severity/confidence labels here are manual and source-backed.

## Non-goals

- No line-by-line correctness proof of either repo.
- No live exploit, fuzzing, or penetration execution.
- No dependency install, build, or bundle generation in the donor.
- No approval of any roadmap item; the roadmap is a draft decision surface.

## Proposal registration

A pending ARCS proposal-doc is registered under project slug `arcs` (stored in the
project data dir, `projects/arcs/proposals/`), carrying the executive design,
the phased recommendations, and stable repo-relative document paths. It is
**pending/unapproved**. Proposal id:

`port-targeted-cc-arcs-improvements-into-arcs-selective-reimplementation`

Data-dir path: `projects/arcs/proposals/port-targeted-cc-arcs-improvements-into-arcs-selective-reimplementation.proposal.md`

Retrieve with:

```sh
arcs proposal-doc list arcs --json
arcs proposal-doc get arcs port-targeted-cc-arcs-improvements-into-arcs-selective-reimplementation
```

The proposal is `status: pending`; it was **not** promoted. This README is the
navigation surface for the repo-relative evidence; [verification.md](./verification.md)
records the registration and validation results.
