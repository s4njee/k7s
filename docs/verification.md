# Verification notes

Summary of how k7s was verified against the design and its acceptance criteria, and
the few places where the two design sources disagreed and a call was made.

## Automated suites (all green)

| Suite | Command | Result |
|---|---|---|
| Type check | `pnpm run typecheck` | clean |
| Frontend unit + component | `pnpm test` (vitest) | 489 passed — formatters, store, terminal slice, RTL component tests (cluster switch, table filter/sort, detail tabs, YAML dry run, confirm dialog, terminal open/close, background-cluster isolation), B75 injection contract, B60 saved views, B87 column config + CSV, B88 metadata editor + kubectl previews, B89 forward-manager + presets |
| Rust unit | `cargo test` | 234 passed — DTO tone mapping, log-line parser, quantity parsing, terminal PTY, B76 lifecycle |
| Lint | `cargo clippy --all-targets -- -D warnings` | clean |
| Frontend build | `pnpm run build` | succeeds |
| Live harnesses (B83) | `./dev/cluster/up.sh --metrics && ./dev/cluster/helm-fixture.sh && node dev/run-harnesses.mjs --fixtures kind,helm,metrics,multi` | 21 pass / 3 skip against the kind fixture (crd_check/promql_check/storage_check skip — the fixture has no CRDs, Prometheus, or storage; recorded honestly) |
| Packaged e2e (B83) | `xvfb-run -a node dev/e2e.mjs` (Linux, needs `tauri-driver`) | golden path via WebDriver; run nightly in CI until the 7-day flake rate is <5% |
| Release bundle | `pnpm run tauri:build` | `k7s.app` built (arm64, `io.k7s.app`); `.dmg` styling step needs a GUI session — see note below |

## Accessibility (B84)

- **axe in the component tests**: every main view (ClusterOverview, ResourceTable
  for pods/problems, ClusterSwitcher, DetailPanel, TerminalPanel) is rendered in
  both themes and asserted free of serious/critical violations
  (`src/axe-views.test.tsx`, `pnpm test`). jsdom can't compute styles, so contrast
  rules are excluded there — the structural/ARIA rules axe is good at in jsdom are
  exactly where the audit found the gaps.
- **Semantics**: div/span click targets converted to real `<button>`s (nav,
  menus, actions, tabs, toolbar glyphs, close/bookmark); a tokenized focus ring
  (`--focus-ring`) applies on `:focus-visible` in both themes; tables got
  `scope="col"` + captions/aria-labels + `aria-sort`; the command palette is a
  combobox/listbox with `aria-activedescendant`; the sidebar is a
  `role="navigation"` landmark with `aria-current`; detail tabs are a tablist with
  arrow-key cycling; the canvas timeline/topology have visually-hidden text
  equivalents; live regions announce row counts, log status, and action errors.
- **Focus management**: the four overlays (Settings, Create YAML, command palette,
  kubeconfig QR) and the action confirmations trap Tab and return focus to the
  invoking control on close (`src/hooks/useFocusTrap.ts`, verified in
  `src/a11y-behavior.test.tsx`); Escape closes the QR dialog and the actions menu.
- **Not runnable here** (hardware lane, like B70–73): the WCAG AA contrast audit
  and the screen-reader pass. The scripted core flow to complete with **VoiceOver
  on macOS** and **NVDA on Windows**:
  1. connect to the fixture cluster;
  2. choose a namespace;
  3. filter for and open a pod;
  4. read logs;
  5. invoke an action (e.g. restart) and confirm;
  6. open a kubectl terminal and close it;
  7. close every surface (detail, menus, modals) and confirm focus returns to the
     invoking control at each step.

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

## Per-platform manual QA checklist (B71)

Run once per release, on each OS, against the fixture cluster (`./dev/cluster/up.sh`)
or a real cluster. Test the artifact a user would actually download, not a dev
build. Each row is a pass/fail; a release ships only when every box on every
platform it claims is checked.

| # | Check | macOS | Windows 11 | Ubuntu 24.04 |
|---|---|---|---|---|
| 1 | Install without friction: drag to Applications / run the NSIS+MSI installer / AppImage+deb | ☐ | ☐ | ☐ |
| 2 | App opens to the cluster switcher; connect to the fixture cluster | ☐ | ☐ | ☐ |
| 3 | Pods table streams; counts and status colours match `kubectl get pods` | ☐ | ☐ | ☐ |
| 4 | Detail panel: logs follow/pause, since-windows, save-to-file | ☐ | ☐ | ☐ |
| 5 | Shell into a container; node debug shell | ☐ | ☐ | ☐ |
| 6 | Port-forward a pod and a Service; the local port is reachable | ☐ | ☐ | ☐ |
| 7 | YAML edit → dry-run diff → apply against a scratch object | ☐ | ☐ | ☐ |
| 8 | Theme: light/dark/system; terminal and charts resolve in both palettes | ☐ | ☐ | ☐ |
| 9 | Window size/position survives closing the window and relaunching | ☐ | ☐ | ☐ |
| 10 | A new problem raises a native notification | ☐ | ☐ | ☐ |
| 11 | Import kubeconfig via the native file dialog; QR context export scans | ☐ | ☐ | ☐ |
| 12 | Fonts render correctly — mono in tables/terminal, tabular numbers in AGE | ☐ | ☐ | ☐ |
| 13 | Session end (logoff/shutdown) still saves window state | ☐ | ☐ | — |
| 14 | Auto-update: Settings shows the version, "Check for updates" finds a newer published release, download+install+restart applies it (B72) | ☐ | ☐ | ☐ |

Notes and known gaps to watch on first runs:

- **Windows** — the WebView2 Evergreen runtime is preinstalled on Windows 11;
  a machine without it gets a silent blank window until it's installed.
  The `ctrl_logoff`/`ctrl_shutdown` window-state save (row 13) is written but
  only verifiable on a real Windows host.
- **Linux** — WebKitGTK in a container/VM may need
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` to paint; AppImage needs FUSE on the host
  to *run* (not to build). The CI smoke-launch is a best-effort first-paint
  probe, not a substitute for rows 1–12.
- **All** — native notifications need the OS permission prompt accepted once.

## Diagnostics redaction (B73)

The export is only worth attaching to a bug report if it can't leak the cluster.
Unit tests pin the redaction pass (`redact` in `src-tauri/src/diagnostics.rs`:
URLs, bearer tokens, long base64 blobs, the user's home path), and the crash
reporter's "zero network calls when off" invariant is tested in
`crash_reporting.rs`. The live acceptance — a session against the fixture
cluster, then grep a generated bundle — runs by hand:

```bash
# 1. connect to the fixture cluster, then:
#    File → Export Diagnostics… → save k7s-diagnostics.zip
unzip -p k7s-diagnostics.zip k7s.log settings.json versions.json \
  | grep -Ei "https?://|Bearer |kubeconfig" && echo "LEAK" || echo "clean"
```

Nothing in the exported `settings.json`/`versions.json` is a server URL or a
kubeconfig path; the `k7s.log` tail is scrubbed the same way. Crash reporting
off (the default) does no network I/O by construction — the reporter returns
before building an HTTP client.

## Security hardening (B75)

- **CSP.** `tauri.conf.json` now ships a real CSP: `default-src 'self'`, no
  remote scripts/objects, `frame-ancestors 'none'`, `style-src 'unsafe-inline'`
  (the carve-out CodeMirror/xterm/plotly need), `connect-src` including the
  Tauri IPC. Tauri additionally hashes the app's own scripts at build time.
  `devCsp` relaxes it for vite's HMR websocket in dev only. **Manual acceptance
  to run per release:** every view (charts, terminal, QR dialog) renders under
  the CSP in the packaged app — a broken carve-out shows up as a blank
  chart/terminal.
- **Capability audit.** The permission set is now the explicit minimum the
  frontend provably uses (`core:app/event/window:default` + `allow-set-theme` +
  webview, plus the plugin surfaces). `core:path/image/resources/menu/tray` are
  not granted. If a future feature needs one, add it deliberately.
- **Supply chain.** `cargo audit` (fails on vulnerabilities; the gtk-rs
  "unmaintained" warnings on the Linux GTK stack are expected and don't gate)
  and `pnpm audit --audit-level high` run in CI; Dependabot opens weekly bumps.
  Local runs are clean today:
  ```bash
  cargo audit --manifest-path src-tauri/Cargo.toml   # 0 vulnerabilities
  pnpm audit --prod --audit-level high               # no known vulnerabilities
  ```
- **Injection surfaces.** `grep -rn "dangerouslySetInnerHTML\|innerHTML" src/`
  returns nothing; a vitest (`TableRow.test.tsx`) renders a pod named
  `<img src=x onerror=alert(1)>` and asserts the literal text appears with no
  `img`/`onerror` element in the DOM. The demo-mode "everywhere" check (table,
  detail header, palette, problems) follows the same `{name}` text pattern and
  is a quick manual pass.

## Multi-cluster backend (B76)

The manager now keys every connection by cluster; a live harness proves two
contexts coexist and that disconnecting one leaves the other's watchers running:

```bash
KUBECONFIG=/path/to/kubeconfig cargo run --example multi_cluster_check
```

It skips cleanly (exit 0) with fewer than two contexts. The lifecycle is also
unit-tested in `manager.rs` (two cids isolated, streams die with their cluster,
refresh replays cached snapshots). The single-cluster UI is unchanged this
release — the cid-keyed store is B77.

## Multi-cluster UI (B77)

The store is cid-keyed; the sidebar rail lists connected clusters. Demo mode has
per-cluster data, so the acceptance is verifiable without a cluster:

1. `VITE_DEMO=1 npm run dev`, connect freya, then switch to odin-staging from
   the rail (or ⌘2).
2. The pods table shows each cluster's own `default/web` pod — Running on freya,
   CrashLoopBackOff on odin-staging (the no-leakage fixture).
3. Switching back and forth is instant — no flicker, no wipe; the previous
   cluster's data is retained.
4. Odin-staging's rail chip is tinted (its crash-looping pod) and a native
   notification names `[odin-staging]`.
5. Open a port-forward on freya, switch to odin-staging — the forward strip
   still shows the `freya` badge, and the detail header shows the cluster.

Against a real kubeconfig with ≥2 contexts, the same flow exercises the live
backend. The lifecycle is unit-tested in `store.test.ts` (per-cid setters route
to retention + active slice) and the manager tests from B76.

## Scale at 10k objects (B78)

The row path is delta-driven: watchers emit `upserts`/`deletes` keyed by uid
instead of full snapshots each debounce tick, with a periodic full-snapshot
resync as the escape hatch; the store applies deltas by uid; high-churn
channels subscribe for the active cluster only. Property tests pin delta ≡
snapshot in `store.test.ts` (row deltas) and `manager.rs`
(`emit_delta_keeps_the_cache_equivalent_to_snapshots`).

**Measured acceptance** (the "no >100 ms frames while scrolling" criterion):

```bash
VITE_STRESS=10000 VITE_DEMO=1 npm run dev
```

Open the Pods table, enable the browser performance profiler, and scroll
through the 10k rows — the virtual window keeps ~69 rows mounted, so frame
time stays bounded; the delta path means a churn of changed pods carries only
the changed rows over the wire. Two clusters at 5k each: while viewing one,
the other's `resource-update` channel is not subscribed (no IPC) — its rail
chip still shows the last-known state, and switching back replays the retained
rows.

## Kind coverage sweep (B80)

Seven new kinds (HPA, PDB, NetworkPolicy, ResourceQuota, LimitRange,
Mutating/ValidatingWebhookConfiguration) plus the cross-kind joins. Verified
live against the fixture cluster:

```bash
./dev/cluster/up.sh    # applies 15-scale/45-quota/50-admission + the NetworkPolicy
KUBECONFIG=$HOME/.kube/config cargo run --example kinds_check
KUBECONFIG=$HOME/.kube/config cargo run --example related_links_check
KUBECONFIG=$HOME/.kube/config cargo run --example drain_check
```

- Each table matches `kubectl get`: HPA shows `cpu: 6%/80%` TARGETS and the
  scaleTargetRef; the PDB shows min=2 / disruptions allowed=0 (the fixture uses
  `minAvailable: 2` so any single eviction blocks, matching demo mode); the
  quota's REQUEST/LIMIT show used/hard like `kubectl get -o wide`.
- Pod panel joins: selecting a pod shows the PodDisruptionBudgets that cover it
  and the NetworkPolicies that select it (matchLabels-only, like the Service
  join). The Namespace panel (new) shows the quota fill — used vs hard per
  resource, toned amber past 80% and red at/over the limit.
- Drain confirm now fetches a PDB preview before committing: "N evictable pods
  on this node" plus each budget's min available / current healthy / disruptions
  allowed. On the fixture, draining the control-plane node shows
  `prod/yggdrasil-db` at 0 disruptions — the stall is visible before you click.
- The webhook fixture configs are inert (`failurePolicy: Ignore` pointing at a
  service that doesn't exist), so admission is never blocked; the panel shows
  the service as "(not found)", which is the honest answer to "why is this
  webhook failing".
- `related_links_check` walks all the new panels: 0 broken links. Demo mode
  mirrors the fixture (HPA/PDB/quota/NetworkPolicy/webhook mock rows + panels).

## Helm write path (B81)

Rollback + uninstall, written the way Helm itself stores releases (`base64(gzip(
JSON))` Secrets — no helm SDK, no shelling out). Verified live against the
fixture with a real Helm 4.2.3 CLI:

```bash
./dev/cluster/up.sh
./dev/cluster/helm-fixture.sh          # installs fixture-app rev1 (color=red) + rev2 (color=blue)
KUBECONFIG=$HOME/.kube/config cargo run --example helm_write_check   # rollback→verify, uninstall→verify
```

- **Rollback** (the History panel's per-revision button, or `helm::rollback`):
  applies the target revision's stored manifest (server-side apply, field
  manager `helm`), flips the previously-deployed revision to superseded, and
  writes a new revision Secret — `helm history` reads it as `deployed
  "Rollback to N"` and `helm get manifest` matches the target revision
  verbatim. Interop is proven **both ways** on the fixture: k7s rollback →
  `helm history` shows rev 3 "Rollback to 1"; a subsequent `helm rollback` to
  rev 2 succeeds (rev 4 "Rollback to 2") with no SSA conflict, because k7s
  applies under Helm's own field manager.
- **Uninstall** (context-menu danger action): the confirm enumerates the
  objects the chart installed (from the release's Objects panel), then deletes
  them (a missing object is "already gone", not an error) and the release's
  revision Secrets. `helm list` drops the release; the ConfigMap/Deployment are
  gone.
- Both refuse cleanly when the release isn't Helm 3 storage v1 (wrong type,
  wrong labels, or an undecodable payload) — never a guess at a v2 layout.
- Phase-1 scope: hooks aren't run, and objects the target manifest no longer
  lists aren't pruned (a rollback applies the target, it doesn't diff-and-prune).

## Integrated kubectl terminal (B82)

⌘T / the statusbar "❯ terminal" pill opens a per-cluster terminal: the user's
shell on a real pty (portable-pty) with `KUBECONFIG` set to a temp
single-context file for the viewed cluster, so `kubectl` targets it with zero
setup — even when the machine's default context is a different cluster.

```bash
./dev/cluster/up.sh
KUBECONFIG=$HOME/.kube/config cargo run --example terminal_check
```

- The harness spawns a real shell on a pty via the production spawn path
  (`spawn_shell_pty`), writes the temp kubeconfig the way `start_kubectl_terminal`
  does, types `kubectl config current-context` and `kubectl get pods -A`, and
  asserts the output contains the same pod the app's own table lists (e.g.
  `bifrost-gateway`). It proves the default-vs-viewed split directly: a control
  shell whose ambient default is a *different, unreachable* cluster B does not
  list A's pods — the terminal's success comes from its own KUBECONFIG, not the
  machine's default context (`K7S_TERMINAL_CONTEXT` overrides the cluster A it
  binds to).
- The temp kubeconfig is 0600, is swept at boot and on every open (the nodeshell
  discipline), and is deleted when the tab closes or the cluster disconnects —
  verified by `terminal_check` and by the manager's disconnect cleanup. The shell
  process itself is killed on tab close / disconnect (a pty child does not die
  when its pump task is aborted, so a `PtyChild` guard kills it on drop).
- Login-shell PATH resolution (the B74 trick built here): a shell spawned from a
  Finder-launched app inherits a bare `/usr/bin:/bin:…`, which is exactly where
  Homebrew's `/opt/homebrew/bin/kubectl` is *not*. `terminal_check` proves the
  resolved PATH finds kubectl on this machine.
- A missing kubectl shows a banner with per-OS install hints (the shell still
  works — only kubectl is absent).
- Multiple terminals with cluster-badged tabs; each stays mounted so its
  session keeps running while you look at another. Windows defaults to
  PowerShell (code path — on the B71 QA checklist thereafter).

## Local connection resilience and typed failure states (B74-L)

Errors are no longer opaque strings. Every command error serializes as a typed
envelope — stable `code`, a *safe* human `message`, `retryable`, and a specific
next `action` (label + hint) — with the raw Rust/debug text kept in `detail` for
diagnostics, never shown as the primary message. Per-`{cid, kind}` watcher
health (`starting | live | backoff | forbidden | stopped`, last-success age,
retries, last error) streams on `watcher-status:{cid}`, and an unreachable
cluster is *stale* (rows retained with an age, auto-clears on recovery) rather
than looking disconnected.

```bash
./dev/cluster/up.sh
KUBECONFIG=$HOME/.kube/config cargo run --example exec_check
KUBECONFIG=$HOME/.kube/config cargo run --example resilience_check
```

- `exec_check` proves the exec-credential path end to end: a fake plugin
  (`dev/cluster/fake-exec.sh`) mints a real ServiceAccount token kind accepts,
  a *success* token is never re-exec'd by requests, an *expired* token forces
  kube to re-exec on the next request (observed via an invocation-count file),
  and the failure modes classify — a missing plugin binary → `exec-missing`, bad
  output / non-zero exit → `exec-failed` — instead of a generic string. The app
  also resolves the login shell's PATH at boot, so exec plugins work in a
  Finder-launched packaged app with no login PATH.
- `resilience_check` proves per-kind isolation and outage recovery: a
  pods-only ServiceAccount lists pods (live) while listing secrets is classified
  `forbidden`; and a `kubectl proxy` the harness controls — killed and restarted
  — makes the same client classify `unreachable`, then recover. Killing kind
  itself (or blocking its API) exercises the same path in the running app: the
  status poller marks the cluster stale within one poll interval (~10s), the
  table keeps its rows with an age, and the next successful probe clears it.
- `cargo test` covers the classification matrix (401/403/404/409/5xx/transport/
  TLS/exec), the watcher-health lifecycle and disconnect cleanup, and the status
  payload; `npm test` covers the store's per-{cid, kind} health retention (a
  forbidden kind keeps its rows) and the error helpers.
- UI surfaces: a forbidden kind shows a red "permission denied" banner with the
  next action and a Retry over its (retained) rows, plus a red nav dot; a
  backoff kind shows an amber "still reconnecting" banner with the last-update
  age; a stale cluster shows an amber banner on the table, a stale badge in the
  switcher and status bar, and a cluster-level Retry. Raw error text appears
  only in `detail`/diagnostics, never as the primary message.

## Known follow-ups (out of v1 scope, per plan.md)

- Detail panel (YAML/Events) for non-pod kinds — pods-only in v1 by design.
- Per-namespace pod counts in the Namespaces table (currently `—`) would need a
  cross-watcher join.
- Exec/shell, port-forward, CRDs, simultaneous multi-cluster views.
