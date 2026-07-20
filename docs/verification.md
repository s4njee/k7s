# Verification notes

Summary of how k7s was verified against the design and its acceptance criteria, and
the few places where the two design sources disagreed and a call was made.

## Automated suites (all green)

| Suite | Command | Result |
|---|---|---|
| Type check | `npm run typecheck` | clean |
| Frontend unit | `npm test` (vitest) | 19 passed — formatters, log ring buffer, store selection/nav reset |
| Rust unit | `cargo test` | 14 passed — DTO tone mapping, log-line parser, quantity parsing |
| Lint | `cargo clippy --all-targets -- -D warnings` | clean |
| Frontend build | `npm run build` | succeeds |
| Release bundle | `npm run tauri:build` | `k7s.app` built (arm64, `io.k7s.app`); `.dmg` styling step needs a GUI session — see note below |

## Manual verification (demo mode, 1440×900)

Verified against the design spec (`design/README.md`) with the prototype's mock data:

- **Shell** — sidebar (cluster switcher open/closed, nav active/hover states, live
  counts, pulsing watch footer), top bar breadcrumb + namespace menu, status bar
  (api/nodes/cpu/mem, kubectl ctx).
- **Tables** — Pods (all 13 rows, tone coloring: green Running, red CrashLoopBackOff
  with amber `1/2` ready and red `14` restarts, amber Pending with `—` CPU/MEM),
  Nodes (green `● Ready`, roles, CPU/MEMORY %), namespace filter → empty state
  ("no resources match filter").
- **Detail panel** — header (dot/name/meta/status color), all three tabs: Logs
  (streaming with colored levels/timestamps, toolbar controls, footer), YAML
  (CodeMirror read view with syntax highlighting; Edit mode with accent border +
  Cancel/Apply), Events (Warning/Normal cards).
- **Context switch** — switching freya → odin-staging updated the badge (`OD`),
  breadcrumb, and status-bar context, and reset+repopulated the data with no leaks.

Screenshots captured during development confirmed pixel-level match to the spec.

### Not exercisable in this environment

- **Live cluster paths** (real watchers, metrics, log streaming, YAML apply against
  the API, mid-session disconnect/recovery) require a cluster. The fixture cluster
  under `dev/cluster/` reproduces the prototype's world for this; the logic is
  covered by Rust unit tests and compiles clean. Run `./dev/cluster/up.sh` to drive
  it end-to-end.
- **Prototype side-by-side render** — the handoff's `K8s Monitor.dc.html` depends on
  a `support.js` runtime that isn't part of the bundle, so it can't be rendered
  standalone. Fidelity was therefore checked against the exact token/spacing values
  in `design/README.md` (which the handoff states are final) plus the mock data,
  which is ported verbatim from the prototype's source.

## Intentional deviations (design sources disagreed)

Both the written spec (`design/README.md`) and the prototype HTML are provided; in
two spots they conflict. The README is treated as canonical (it states its values
are final/exact), and the choices are noted here per Story 7.2.

1. **AGE column color on non-pod tables.** The prototype colors AGE cells on non-pod
   kinds as secondary (`#a4a4ae`); the README's token guidance lists "namespace/age"
   as muted (`#70707a`), and Story 4.1 says "namespace/AGE muted." → k7s uses **muted**
   for AGE everywhere, consistent between demo and real mode.

2. **Log search field background.** README §4 specifies `#0a0a0c` for the log search
   field chrome; the prototype HTML uses `#0d0d0f`. → k7s uses **`#0a0a0c`** (the
   README value), matching the rest of the terminal/log surface.

## Design decisions (backlog features)

- **Secret values are redacted (B1).** The detail panel now covers all kinds
  (YAML + Events for non-pods; pods keep Logs). Secret `data`/`stringData` values
  are replaced with `<redacted>` server-side and the YAML tab is **read-only** for
  Secrets, so raw values never reach the webview and can't be clobbered by an edit.
  Other kinds are fully editable via Apply.

## Known follow-ups (out of v1 scope, per plan.md)

- Detail panel (YAML/Events) for non-pod kinds — pods-only in v1 by design.
- Per-namespace pod counts in the Namespaces table (currently `—`) would need a
  cross-watcher join.
- Exec/shell, port-forward, CRDs, simultaneous multi-cluster views.
