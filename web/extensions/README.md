# pi extensions (repo-owned)

## arcs-sidebar — ARCS panel + web status + TUI modal reader (recommended)

The consolidated ARCS extension for pi. It keeps the Atelier overview panel
and the `arcs-web` footer status, and adds an interactive in-terminal modal
reader — Atelier sidebar rows are display-only, so reading happens in the
modal.

| Piece | Behavior |
|-------|----------|
| Atelier panel | Live `ARCS` panel via `pi-atelier:sidebar-panels` (phase, health, next task, plan counts) |
| Footer | `●/○ arcs-web 127.0.0.1:<port>` from `GET /api/health` every ~5s (kept on down) |
| `/arcs-open [target]` | Keyboard-driven TUI overlay modal: `brief \| next \| status \| plan <id> \| task <id>`; no args opens a picker |
| `/arcs-web` | Opens the web UI detached; scoped to `/p/<slug>` when the cwd resolves to a project |
| `/arcs-refresh` | Refreshes panel + footer immediately |

Modal keys: `j/k` or `↑/↓` scroll, `space` page, `g/G` top/bottom, `q`/`Esc` close.

Installed automatically by `arcs init` (pi deploy step) to
`~/.pi/agent/extensions/arcs-sidebar.ts`. A file you modified by hand is
never overwritten — the deploy reports `extensionSkipped: "user-modified"`
and leaves it alone. Manual install:

```bash
cp web/extensions/arcs-sidebar.ts ~/.pi/agent/extensions/
```

---

# arcs-web-status — ARCS web server status in pi

A small pi extension that shows whether the ARCS web server is up in pi's
footer/status bar. Polls `GET http://127.0.0.1:<port>/api/health` on session
start and every ~5s (overlapping polls are skipped while a fetch is still in
flight; all fetch errors just flip the entry to down).

| State | Status entry (`ctx.ui.setStatus("arcs-web", …)`) |
|-------|---------------------------------------------------|
| up    | `● arcs-web 127.0.0.1:8745`                       |
| down  | `○ arcs-web 127.0.0.1:8745` (entry stays visible) |

Also registers `/arcs-web` to open the web UI in your browser.

## Install

From the repo root (quick test, loads on this invocation only):

```bash
pi -e web/extensions/arcs-web-status.ts
```

Persistent install — copy the file into an auto-discovered extension dir
(global or project-local) so it loads on every pi start and supports `/reload`:

```bash
mkdir -p ~/.pi/agent/extensions
cp web/extensions/arcs-web-status.ts ~/.pi/agent/extensions/
```

Or install and track it via pi settings:

```bash
pi install ./web/extensions/arcs-web-status.ts
```

Uninstall by removing the file / running `pi remove <source>`.

## Port resolution

The extension mirrors how the ARCS server resolves its data dir:
`ARCS_DATA_DIR` env var wins, else `~/.arcs`. It reads
`<data-dir>/web-config.json` (`{ "port": number }`) for the port. If the file
is missing, unreadable, or holds an invalid port, it falls back to the server
default, **8745**.

To use a custom port, start the server with `arcs web --port <p>` once — the
resolved port is persisted to `web-config.json` and picked up on the next pi
load (restart pi or `/reload` to re-read it).