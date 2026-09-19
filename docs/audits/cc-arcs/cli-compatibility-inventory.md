# CLI compatibility inventory — target `a9e7e1b` vs donor `b9c9f63` (DRAFT)

Companion to [README.md](./README.md) and [technical-report.md](./technical-report.md).
Status: **DRAFT / pending approval**. Machine-readable backing:
[cli-compatibility-matrix.json](./cli-compatibility-matrix.json).

Binary names differ (target `arcs`, donor `cc-arcs`); command **path strings are
identical**. All anchors are repo-relative with a repo label; target is
`target@a9e7e1b working tree` (live dirty worktree), donor is `fork@b9c9f63`.

## 1. Method and caveats

- **Static (primary):** TypeScript compiler API parse of every
  `defineCommand({...})` in `src/cli/commands/*.ts`. `params:` identifier
  references and spreads are resolved to top-level `const XParams = {...}` object
  literals. **Unresolved declarations: 0.** After resolution, only `project list`
  has an empty param map in both repos (it genuinely declares no params); no
  `path:` is computed/dynamic and there are 0 duplicate paths.
- **Signature compared over** `{params, description, mutation, errorCodes,
  supportsDryRun}`. `supportsDryRun` is **donor-only metadata** (target has no such
  field), so 22 shared commands differ **only** by that field.
- **Static declaration ≠ behavior.** "Changed" rows are declaration diffs; broader
  behavioral divergence is described separately in §4 and is not fully measured.
  The extractor verified **all 95 union rows** at the declaration level; it did
  **not** verify behavioral equivalence.
- **`t-dry` / `f-dry` are heuristic.** `t-dry` is a **file-level scan for the token
  `flags.dryRun`** across a command's source file, not a handler-level guarantee; a
  read-only command sharing a file with a dry-run-aware neighbor can show `yes`
  without honoring the flag. `f-dry` reflects the donor's declared
  `supportsDryRun`. Do **not** read these columns as safety assurances; the
  authoritative dry-run fact is §3.3 (executed reproduction).
- **Runtime-discovered (target only):** `node scripts/arcs-cli.mjs --commands --json`
  → **81** registry commands = static count. Donor runtime **not measured** (no
  `dist/`, no `node_modules`, no-install constraint); donor static **83** stands
  alone.
- **Dry-run behavior:** the target global `--dry-run` was **reproduced to execute real
  mutations** (reviewer, isolated `ARCS_DATA_DIR`): `done --dry-run` transitioned a
  task `in_progress → done` and `remember --dry-run` created knowledge files.
  See §3.3. `batch` remains static-only confirmed.

## 2. Headline counts (post-resolution)

| metric | target | donor |
|---|---|---|
| registered commands | 81 | 83 |
| router-owned / non-registry | 2 | 4 |
| union of registered paths | 95 | 95 |
| **shared total** | **69** | **69** |
| — shared, same declaration | 34 | 34 |
| — shared, changed declaration | 35 | 35 |
| — of which params/description changed | 13 | 13 |
| — of which differed only by `supportsDryRun` | 22 | 22 |
| target-only | 12 | — |
| donor-only | — | 14 |

Classification: **(a)** shared same declaration; **(b)** shared changed
declaration; **(c)** behavior changes invisible to the registry.

## 3. Anchors — parser, global flags, routing, mutation/enforcement

| topic | target (`target@a9e7e1b`) | donor (`fork@b9c9f63`) |
|---|---|---|
| global flag set | `src/cli/arg-parser.ts` `--json --lean --dry-run --help --token` | `src/cli/arg-parser.ts` `--json --lean --dry-run --help -h` |
| `-h` alias | absent | present (`arg-parser.ts`) |
| general help / `--version` | wrapper-only **minimal static** help (`scripts/arcs-cli.mjs --help`, exit 0); internal `dist/index.js --help`/`--version` exit 1; no `-h`/group help | registry-driven general + group help and `--version`/`-v` (`help-generator.ts`) — see §3.1 |
| `--token` parse | present (`arg-parser.ts`) | absent |
| kebab-case param alias (`--plan-id`) | absent | present (`resolveParamName`) |
| bare string/number flag guard | absent (stores `true`) | present ("requires a value") |
| mutation field | `src/cli/command-registry.ts` | `src/cli/command-registry.ts` |
| dry-run refusal predicate | absent | present (`refusesDryRun`) |
| write gate (`ARCS_GUARDED`) | present (`src/cli/write-gate.ts`) | absent |
| mutation choke point | `src/cli/write-gate.ts`; called from `src/cli/index.ts`, `src/cli/dag-commands.ts` | n/a |
| command routing | leading positional prefix, then legacy fallback `src/cli/dag-commands.ts` | first 2 non-flag tokens (`src/cli/index.ts`) |
| unknown-command error + suggestion | absent from registry path (`return false`) | present (`src/cli/index.ts`, `command-registry.ts` `suggestCommand`) |
| env lean flag | `ARCS_LEAN=1` (`src/cli/lean-output.ts`) | `CC_ARCS_LEAN=1` (`src/cli/lean-output.ts`) |

### 3.1 General help / version [corrected]

- **Public wrapper help works.** `node scripts/arcs-cli.mjs --help` → **exit 0**,
  printing a **minimal static** usage:
  `Usage: arcs <command> [args]` + a short hard-coded command list. This is the
  entry installed by `scripts/arcs-init.mjs` (`~/.local/bin/arcs`).
- **Internal entry is inconsistent.** `node dist/index.js --help` and
  `node dist/index.js --version` → **exit 1**, printing "Unknown command."
  So the target has **no `--version`, no `-h`, and no group help**; its general
  help is a minimal static string in the public wrapper only.
- **Donor** help is **registry-driven** (`help-generator.ts` `generateGeneralHelp`
  / `generateGroupHelp`, plus `--version`/`-v`), so its text cannot drift from the
  command registry.
- **Port recommendation (P1):** add registry-driven help/version to the target so
  the wrapper and internal entry agree. Do **not** describe the target as having
  "no general help".

### 3.2 Routing and interleaved flags [corrected]

- Target matches a **leading positional prefix** and, on mismatch, falls back to
  the legacy `src/cli/dag-commands.ts` path (donor has no `dag-commands.ts`).
- **Interleaved flags do work on the target** via that fallback:
  `node scripts/arcs-cli.mjs task --json list arcs` → **exit 0**, returns the task
  list (verified in [verification.md](./verification.md)). This is **not** a
  universal routing failure; the divergence is that the donor resolves the command
  from the first two non-flag tokens so interleaving is *systematic and uniform*,
  whereas target relies on a legacy fallback of narrower scope.
- No claim of a target routing defect is made here.

### 3.3 Dry-run behavior (reviewer-reproduced on target)

The global `--dry-run` flag **reaches mutating handlers and runs them**. Repro under
isolated `ARCS_DATA_DIR` (ephemeral repro dir; commands reproduced in
[verification.md](./verification.md)):

- `node dist/index.js done demo T1 --dry-run` → status `in_progress → done` (exit 0).
- `node dist/index.js remember demo "hello dry run" --dry-run` → created
  `knowledge/index.json`, `hello-dry-run.md`, `hello-dry-run.meta.json`.
- `batch` ignores `_flags` (unconditional `updateTask`/`createKnowledgeEntry`) —
  **static-confirmed only**.

Target has no `supportsDryRun`/`refusesDryRun`/`DRY_RUN_UNSUPPORTED` predicate;
the donor refuses centrally (`refusesDryRun`, gate in `src/cli/index.ts`).
Representative rows:

| command | target anchor (declares mutation, no dry-run read) | donor equivalent |
|---|---|---|
| `batch` | `src/cli/commands/batch.ts` (`_flags` unused) | `mutation: true`, no `supportsDryRun` → refused |
| `diagram init` / `sort-metadata` / `status` | `src/cli/commands/diagram.ts` | refused in donor |
| `proposal drop` / `promote` | `src/cli/commands/proposal.ts` | refused in donor |
| `remember`, `done`, `proposal backfill` | `remember.ts`, `done.ts`, `proposal.ts` | donor adds `supportsDryRun` → supported |

**Port recommendation (P1):** adopt the donor's central `refusesDryRun` predicate and
declare `supportsDryRun` truthfully (or honor the flag), **while retaining
`--token`/`ARCS_GUARDED`**, and add regression tests for `done`/`remember`/`batch`.

## 4. Behavior changes not visible from the registry

- **Parser hardening** (`arg-parser.ts`): kebab-case aliases and the bare-value
  guard change accepted inputs without changing any registry row.
- **Batch op namespace** (`src/cli/commands/batch.ts`): donor renamed canonical
  `doc-update` → `project-doc-update` (keeping `doc-update` as a deprecated alias),
  added `doc-create`/`doc-update-meta`/`doc-update-body`/`doc-delete`, replaced
  knowledge `op.code` chunk capture with `op.commits`, and dropped `skill`/`workMode`
  forwarding on task ops. Target keeps `op.code` capture and forwards
  `skill`/`workMode`. `doc-promote` is deliberately **not** a batch op in the donor.
- **Envelope:** `render()` (`src/cli/output-envelope.ts`) is byte-identical across
  repos; the only envelope-adjacent change is which flags reach it.
- **Interleaved routing** (§3.2).

## 5. Changed-parameter rows (compatibility-sensitive)

These are the 13 shared commands whose **params or description** changed. The
port must **preserve target flags** for compatibility; donor additions are additive.

| command | Δparams (`-` target-only, `+` donor-only, `~` differing) | note |
|---|---|---|
| `deploy-pi-superpowers` | `-project-root -scope` (description changed) | donor drops Pi install-scope flags |
| `done` | `-no-report -since -commit +no-ledger` | donor drops receipt capture flags, adds ledger flag — **keep target receipt flags** |
| `knowledge create` | `-code +body-stdin +commits` | donor replaces `--code` chunk capture with `--commits` |
| `knowledge upsert` | `-code +body-stdin +commits` | same |
| `knowledge update-meta` | `-code +commits` | same |
| `next` | `+brief +full` | donor-only additions |
| `plan create` | `+body-stdin` | donor-only |
| `plan delete` | `+cascade` | donor-only destructive cascade — see roadmap (defer/reject) |
| `plan get` | `-diff` | donor drops `--diff` |
| `remember` | `-code +task` | donor drops `--code` capture, adds `--task` |
| `search` | `~slug ~query` (description changed) | spec differs |
| `task create` | `-workMode` | donor drops `--workMode` |
| `task update` | `-workMode` | donor drops `--workMode` |

Remaining 22 changed rows differ **only** by the donor-only `supportsDryRun` field.

## 6. Router-owned (non-registry) commands

| command | target | donor | notes |
|---|---|---|---|
| `init` / `config` | yes (`runSetup`) | yes (`runSetup`) | interactive |
| `init-skills` | no | yes | donor-only |
| `console` | no | yes | donor-only long-running server |
| `--commands [--json]` | yes | yes | discovery |
| `--version` / `-v` | no | yes | donor-only |
| bare `--help` / `-h`, `<group> --help` | wrapper-only minimal (internal exit 1) | yes, registry-driven | see §3.1 |

## 7. Global flags

| flag | target | donor |
|---|---|---|
| `--json` / `--lean` / `--dry-run` / `--help` | yes | yes |
| `-h` | no | yes |
| `--token[=v]` | yes | no |
| `--version` / `-v` | no | yes |

## 8. Per-command matrix (all 95 union rows)

`class`: a = shared same decl, b = shared changed decl, T = target-only, F = donor-only.
`t-dry` = **file-level** scan for `flags.dryRun` in the target command's file
(heuristic — see §1; not handler-level); `f-dry` = donor declares `supportsDryRun`.
`Δparams`: `-` target-only, `+` donor-only, `~` differing spec. `kind` = components of
a changed declaration.

| class | command | target file | donor file | t-mut | f-mut | t-dry | f-dry | Δparams | kind |
|---|---|---|---|---|---|---|---|---|---|
| a | `agents-md` | utility.ts | utility.ts | no | no | no | no | — | — |
| a | `audit` | diagnostics.ts | diagnostics.ts | no | no | no | no | — | — |
| a | `batch` | batch.ts | batch.ts | yes | yes | no | no | — | — |
| a | `brief` | brief.ts | brief.ts | no | no | no | no | — | — |
| a | `codegraph-sync` | maintenance.ts | maintenance.ts | yes | yes | yes | no | — | — |
| a | `context` | utility.ts | utility.ts | no | no | no | no | — | — |
| b | `dependency add` | dependency.ts | dependency.ts | yes | yes | yes | yes | — | supportsDryRun |
| b | `dependency remove` | dependency.ts | dependency.ts | yes | yes | yes | yes | — | supportsDryRun |
| b | `deploy-claudecode-superpowers` | bundle.ts | bundle.ts | yes | yes | yes | yes | — | supportsDryRun |
| b | `deploy-pi-superpowers` | bundle.ts | bundle.ts | yes | yes | yes | yes | -project-root -scope | params+description+supportsDryRun |
| b | `deploy-superpowers` | bundle.ts | bundle.ts | yes | yes | yes | yes | — | supportsDryRun |
| a | `diagram init` | diagram.ts | diagram.ts | yes | yes | no | no | — | — |
| a | `diagram inspect` | diagram.ts | diagram.ts | no | no | no | no | — | — |
| a | `diagram ready` | diagram.ts | diagram.ts | no | no | no | no | — | — |
| a | `diagram show` | diagram.ts | diagram.ts | no | no | no | no | — | — |
| a | `diagram sort-metadata` | diagram.ts | diagram.ts | yes | yes | no | no | — | — |
| a | `diagram status` | diagram.ts | diagram.ts | yes | yes | no | no | — | — |
| a | `diagram validate` | diagram.ts | diagram.ts | no | no | no | no | — | — |
| a | `diff` | diagnostics.ts | diagnostics.ts | no | no | no | no | — | — |
| F | `doc breakdown` | — | doc.ts | — | no | — | no | — | — |
| F | `doc create` | — | doc.ts | — | yes | — | yes | — | — |
| F | `doc delete` | — | doc.ts | — | yes | — | yes | — | — |
| F | `doc get` | — | doc.ts | — | no | — | no | — | — |
| F | `doc list` | — | doc.ts | — | no | — | no | — | — |
| F | `doc outline` | — | doc.ts | — | no | — | no | — | — |
| F | `doc promote` | — | doc.ts | — | yes | — | yes | — | — |
| F | `doc template` | — | doc.ts | — | no | — | no | — | — |
| b | `doc update` | dependency.ts | dependency.ts | yes | yes | yes | yes | — | supportsDryRun |
| F | `doc update-body` | — | doc.ts | — | yes | — | yes | — | — |
| F | `doc update-meta` | — | doc.ts | — | yes | — | yes | — | — |
| b | `done` | done.ts | done.ts | yes | yes | no | yes | -no-report -since -commit +no-ledger | params+supportsDryRun |
| a | `git-log` | maintenance.ts | maintenance.ts | no | no | yes | no | — | — |
| a | `graph inspect` | graph.ts | graph.ts | no | no | no | no | — | — |
| b | `knowledge create` | knowledge.ts | knowledge.ts | yes | yes | yes | yes | -code +body-stdin +commits | params+supportsDryRun |
| b | `knowledge delete` | knowledge.ts | knowledge.ts | yes | yes | yes | yes | — | supportsDryRun |
| a | `knowledge get` | knowledge.ts | knowledge.ts | no | no | yes | no | — | — |
| a | `knowledge list` | knowledge.ts | knowledge.ts | no | no | yes | no | — | — |
| a | `knowledge search` | knowledge-search.ts | knowledge-search.ts | no | no | no | no | — | — |
| a | `knowledge template` | knowledge.ts | knowledge.ts | no | no | yes | no | — | — |
| b | `knowledge update-body` | knowledge.ts | knowledge.ts | yes | yes | yes | yes | — | supportsDryRun |
| b | `knowledge update-meta` | knowledge.ts | knowledge.ts | yes | yes | yes | yes | -code +commits | params+supportsDryRun |
| b | `knowledge upsert` | knowledge.ts | knowledge.ts | yes | yes | yes | yes | -code +body-stdin +commits | params+supportsDryRun |
| a | `lint-bundle` | bundle.ts | bundle.ts | no | no | yes | no | — | — |
| b | `loop cancel` | loop.ts | loop.ts | yes | yes | yes | yes | — | supportsDryRun |
| b | `loop start` | loop.ts | loop.ts | yes | yes | yes | yes | — | supportsDryRun |
| a | `loop status` | loop.ts | loop.ts | no | no | yes | no | — | — |
| b | `loop tick` | loop.ts | loop.ts | yes | yes | yes | yes | — | supportsDryRun |
| b | `next` | next.ts | next.ts | no | no | no | no | +brief +full | params |
| b | `paths update` | dependency.ts | dependency.ts | yes | yes | yes | yes | — | supportsDryRun |
| F | `plan changes` | — | changes.ts | — | no | — | no | — | — |
| b | `plan create` | plan.ts | plan.ts | yes | yes | yes | yes | +body-stdin | params+supportsDryRun |
| b | `plan delete` | plan.ts | plan.ts | yes | yes | yes | yes | +cascade | params+supportsDryRun |
| b | `plan get` | plan.ts | plan.ts | no | no | yes | no | -diff | params |
| a | `plan list` | plan.ts | plan.ts | no | no | yes | no | — | — |
| b | `plan update-body` | plan.ts | plan.ts | yes | yes | yes | yes | — | supportsDryRun |
| b | `plan update-meta` | plan.ts | plan.ts | yes | yes | yes | yes | — | supportsDryRun |
| a | `project get` | project.ts | project.ts | no | no | yes | no | — | — |
| b | `project init` | project.ts | project.ts | yes | yes | yes | yes | — | supportsDryRun |
| a | `project list` | project.ts | project.ts | no | no | yes | no | — | — |
| b | `project update-doc` | project-updates.ts | project-updates.ts | yes | yes | yes | yes | — | supportsDryRun |
| b | `project update-paths` | project-updates.ts | project-updates.ts | yes | yes | yes | yes | — | supportsDryRun |
| b | `project update-status` | project-updates.ts | project-updates.ts | yes | yes | yes | yes | — | supportsDryRun |
| a | `project validate` | project.ts | project.ts | no | no | yes | no | — | — |
| b | `project write-checkpoint` | project-updates.ts | project-updates.ts | yes | yes | yes | yes | — | supportsDryRun |
| b | `proposal backfill` | proposal.ts | proposal.ts | yes | yes | no | yes | — | supportsDryRun |
| a | `proposal drop` | proposal.ts | proposal.ts | yes | yes | no | no | — | — |
| a | `proposal list` | proposal.ts | proposal.ts | no | no | no | no | — | — |
| a | `proposal promote` | proposal.ts | proposal.ts | yes | yes | no | no | — | — |
| T | `proposal-doc create` | proposal-doc.ts | — | yes | — | yes | — | — | — |
| T | `proposal-doc edit` | proposal-doc.ts | — | yes | — | yes | — | — | — |
| T | `proposal-doc get` | proposal-doc.ts | — | no | — | yes | — | — | — |
| T | `proposal-doc list` | proposal-doc.ts | — | no | — | yes | — | — | — |
| T | `proposal-doc promote` | proposal-doc.ts | — | yes | — | yes | — | — | — |
| a | `related` | graph.ts | graph.ts | no | no | no | no | — | — |
| b | `remember` | remember.ts | remember.ts | yes | yes | no | yes | -code +task | params+supportsDryRun |
| T | `report get` | report.ts | — | no | — | no | — | — | — |
| T | `report list` | report.ts | — | no | — | no | — | — | — |
| b | `search` | utility.ts | utility.ts | no | no | no | no | ~slug ~query | params+description |
| a | `status` | status.ts | status.ts | no | no | no | no | — | — |
| b | `sync-agents-md` | maintenance.ts | maintenance.ts | yes | yes | yes | yes | — | supportsDryRun |
| F | `task brief` | — | task.ts | — | no | — | no | — | — |
| F | `task changes` | — | changes.ts | — | no | — | no | — | — |
| b | `task create` | task.ts | task.ts | yes | yes | yes | yes | -workMode | params+supportsDryRun |
| b | `task delete` | task.ts | task.ts | yes | yes | yes | yes | — | supportsDryRun |
| a | `task get` | task.ts | task.ts | no | no | yes | no | — | — |
| a | `task list` | task.ts | task.ts | no | no | yes | no | — | — |
| F | `task record-change` | — | changes.ts | — | yes | — | yes | — | — |
| b | `task transition` | task.ts | task.ts | yes | yes | yes | yes | — | supportsDryRun |
| b | `task update` | task.ts | task.ts | yes | yes | yes | yes | -workMode | params+supportsDryRun |
| a | `validate` | utility.ts | utility.ts | no | no | no | no | — | — |
| T | `web` | web.ts | — | no | — | no | — | — | — |
| T | `worktree ensure` | worktree.ts | — | yes | — | yes | — | — | — |
| T | `worktree list` | worktree.ts | — | no | — | yes | — | — | — |
| T | `worktree prune` | worktree.ts | — | yes | — | yes | — | — | — |
| T | `worktree validate` | worktree.ts | — | no | — | yes | — | — | — |

## 9. Command family delta (post-resolution)

| family | target | donor | shared-same | shared-changed | target-only | donor-only |
|---|---|---|---|---|---|---|
| agents-md | 1 | 1 | 1 | 0 | — | — |
| audit | 1 | 1 | 1 | 0 | — | — |
| batch | 1 | 1 | 1 | 0 | — | — |
| brief | 1 | 1 | 1 | 0 | — | — |
| codegraph-sync | 1 | 1 | 1 | 0 | — | — |
| context | 1 | 1 | 1 | 0 | — | — |
| dependency | 2 | 2 | 0 | 2 | — | — |
| deploy-claudecode-superpowers | 1 | 1 | 0 | 1 | — | — |
| deploy-pi-superpowers | 1 | 1 | 0 | 1 | — | — |
| deploy-superpowers | 1 | 1 | 0 | 1 | — | — |
| diagram | 7 | 7 | 7 | 0 | — | — |
| diff | 1 | 1 | 1 | 0 | — | — |
| doc | 1 | 11 | 0 | 1 | — | breakdown, create, delete, get, list, outline, promote, template, update-body, update-meta |
| done | 1 | 1 | 0 | 1 | — | — |
| git-log | 1 | 1 | 1 | 0 | — | — |
| graph | 1 | 1 | 1 | 0 | — | — |
| knowledge | 9 | 9 | 4 | 5 | — | — |
| lint-bundle | 1 | 1 | 1 | 0 | — | — |
| loop | 4 | 4 | 1 | 3 | — | — |
| next | 1 | 1 | 0 | 1 | — | — |
| paths | 1 | 1 | 0 | 1 | — | — |
| plan | 6 | 7 | 1 | 5 | — | changes |
| project | 8 | 8 | 3 | 5 | — | — |
| proposal | 4 | 4 | 3 | 1 | — | — |
| proposal-doc | 5 | 0 | 0 | 0 | create, edit, get, list, promote | — |
| related | 1 | 1 | 1 | 0 | — | — |
| remember | 1 | 1 | 0 | 1 | — | — |
| report | 2 | 0 | 0 | 0 | get, list | — |
| search | 1 | 1 | 0 | 1 | — | — |
| status | 1 | 1 | 1 | 0 | — | — |
| sync-agents-md | 1 | 1 | 0 | 1 | — | — |
| task | 6 | 9 | 2 | 4 | — | brief, changes, record-change |
| validate | 1 | 1 | 1 | 0 | — | — |
| web | 1 | 0 | 0 | 0 | — | — |
| worktree | 4 | 0 | 0 | 0 | ensure, list, prune, validate | — |

## 10. What this inventory does and does not prove

- **Proves:** the declared command/param surfaces and their declaration-level drift,
  plus verbatim parser/router/global-flag anchors and target runtime discovery (81).
- **Does not prove:** runtime behavior of any command, dry-run side effects, donor
  runtime surface, or whether a "changed" declaration is a behavioral regression.
