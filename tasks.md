# k7s — Implementation tasks

Epics and stories for implementing the plan in [plan.md](plan.md). Work epics **in order**; stories within an epic are ordered and list explicit dependencies where they cross epics.

**Design source of truth:** [design/README.md](design/README.md) (referenced below as *Design §N*) and the interactive prototype [design/K8s Monitor.dc.html](design/K8s%20Monitor.dc.html) (open in a browser; its `class Component` script defines mock data, column sets, coloring rules, and interactions). Fidelity is **pixel-perfect** — all colors/sizes/spacing in Design are exact values, not suggestions. When a story says "per Design §N", every styling value in that section applies even if not restated here.

**Definition of done (every story):**
- `cargo clippy --all-targets -- -D warnings` and `cargo test` pass (when Rust touched).
- `tsc --noEmit` and `vitest` pass (when frontend touched).
- App launches (`npm run tauri dev`) without console errors; the story's acceptance criteria demonstrated in **demo mode** (`VITE_DEMO=1`) or against the fixture cluster (E7.1) as appropriate.
- No hardcoded hex values in components — colors come from `tokens.css` custom properties only.

---

## Epic 1 — Scaffold & design foundation

**Goal:** Tauri v2 + React + Vite + TS project boots; design tokens, fonts, and the data-provider seam exist so every later story has rails.
**Exit:** `npm run tauri dev` opens a dark empty window; `VITE_DEMO=1 npm run dev` serves the app shell in a plain browser with mock data flowing through the provider.

### Story 1.1 — Project scaffold
**Do:** Scaffold Tauri v2 app (`create-tauri-app` or manual) with React + TypeScript + Vite in the repo root (`src/` frontend, `src-tauri/` backend). Configure the main window: title `k7s`, default 1440×900, **min size 1280×800**, background color `#0d0d0f` (avoids white flash — Design §Overview/App shell). Add scripts: `dev`, `build`, `tauri dev`, `tauri build`, `typecheck`, `test`. Set bundle identifier (e.g. `io.k7s.app`).
**Accept:**
- [ ] `npm run tauri dev` opens a `#0d0d0f` window, min-size enforced at 1280×800.
- [ ] `npm run typecheck`, `cargo clippy -- -D warnings` pass on the clean scaffold.

### Story 1.2 — Design tokens, fonts, global styles
**Do:** Create `src/styles/tokens.css` defining every value in *Design §Design Tokens* as CSS custom properties (backgrounds, borders, text, accent, semantic colors, radii). Create `global.css`: reset, `html/body` bg `#0d0d0f` text `#d2d2d8` font `13px 'IBM Plex Sans'`, custom scrollbars (10px, thumb `#26262b` radius 5px with 2px `#0d0d0f` border, hover `#34343c`), `@keyframes livePulse` (2s opacity 1→.25→1), `input/textarea { outline:none }`, links `#4d9fff`/hover `#7db8ff`. Bundle **IBM Plex Sans** 400/500/600 and **JetBrains Mono** 400/500/600/700 locally (e.g. `@fontsource`); no network font loads.
**Accept:**
- [ ] Both font families render offline (verify with network disabled).
- [ ] Every hex in Design §Design Tokens exists exactly once, in `tokens.css`.
- [ ] Scrollbar and pulse animation match the prototype visually.

### Story 1.3 — Provider seam, store, mock provider (demo mode)
**Do:** Define `src/providers/types.ts` with the `DataProvider` interface from plan §3.2 plus shared DTO types (`Row`, `Cell{text,tone}`, `PodMeta`, `EventItem`, `ClusterStatus`, `ContextInfo`, `LogLine{ts,level,msg}`). Implement `MockProvider` porting the prototype's data **verbatim** from `design/K8s Monitor.dc.html`: the 13 pods (incl. `heimdall-auth…` CrashLoopBackOff and the Pending canary), all per-kind rows/columns from `resourceDefs`, namespaces (`all, prod, staging, monitoring, kube-system`), 3 clusters (`freya/odin-staging/loki-dev`), the two log pools (normal + crashloop) ticking every ~900ms, the YAML generator, the events sets, cluster-status (`v1.31, 42ms, 6/6, 41%, 63%`), watch count 9. Create the Zustand store with the state fields from plan §3.2 and wire provider selection: `VITE_DEMO=1` → MockProvider, else TauriProvider (stub for now). Add `src/lib/format.ts`: k8s age formatter (`38s / 2h14m / 4d2h / 31d`), cpu (`212m`), memory (`486Mi / 3.2Gi`) — with vitest unit tests.
**Accept:**
- [ ] `VITE_DEMO=1 npm run dev` in a plain browser: store receives mock rows for all 12 kinds, log lines tick, no Tauri import errors.
- [ ] Age/cpu/mem formatters match the prototype's sample values exactly (unit-tested).
- [ ] Tone enum (`default|muted|ok|warn|err`) is the only coloring channel exposed by providers.

---

## Epic 2 — Rust backend: Kubernetes core

**Goal:** Real cluster data flows: contexts, connect, watchers for all 12 kinds, metrics, cluster status — behind the same events/commands contract the MockProvider fakes.
**Exit:** With a kubeconfig present, the app connects and streams live row DTOs for every kind.

### Story 2.1 — Contexts, client manager, connect
**Do:** Add crates: `kube` (features: client, runtime, derive), `k8s-openapi` (latest supported version feature), `tokio`, `serde`/`serde_json`/`serde_yaml`, `thiserror`, `futures`. Implement `ClientManager` (in Tauri managed state, `tokio::sync::RwLock`): holds optional active `kube::Client`, context name, task registry (watchers/log streams/pollers as abortable `JoinHandle`s). Commands: `list_contexts()` via `Kubeconfig::read()` → `[{name, cluster, current}]`; `connect(context)` → build client for that context, probe `/version`, return `{context, clusterName, server, version}`. Errors serialize as readable strings (kubeconfig missing, unreachable, auth failure).
**Accept:**
- [ ] `list_contexts` returns all kubeconfig contexts with the current one flagged.
- [ ] `connect` against a live cluster returns its git version (e.g. `v1.31.x`); against a bogus context returns a clean error string, no panic.
- [ ] Reconnecting/switching aborts every task registered by the previous connection (assert via task registry test).

### Story 2.2 — Watchers → row DTO snapshots
**Do:** On `connect`, spawn one `kube::runtime::watcher` + reflector per kind (Pods, Deployments, StatefulSets, DaemonSets, Jobs, CronJobs, Services, Ingresses, ConfigMaps, Secrets, Nodes, Namespaces), cluster-wide scope. On any change, debounce ~150ms per kind and emit `resource-update { kind, rows }` (full snapshot). Implement `dto.rs` mapping each kind to the **prototype's exact column sets** (Design §3 + prototype `resourceDefs`): e.g. Pods → NAME, NAMESPACE, READY, RESTARTS, CPU, MEM, AGE, STATUS; Deployments → READY, UP-TO-DATE, AVAILABLE, AGE; Nodes → STATUS, ROLES, CPU, MEMORY, VERSION; etc. Encode coloring as cell `tone` per prototype rules: status Running/Ready/Active → `ok` (+ `● ` dot prefix on status cells), Pending → `warn`, CrashLoopBackOff/Failed → `err`; READY `a/b` with a<b or `0/…` → `warn`; restarts >5 → `err`; names `default`(primary); namespace/AGE `muted`. Pod status derives like kubectl (containerStatuses waiting reason > phase). AGE cells carry `creationTs` (frontend formats). Pods rows carry `podMeta { node, containers[], status, ready, restarts }`. Emit `watch-status { active }` on every task start/stop. A kind failing (RBAC/forbidden) must not kill others: empty rows + `warn` log + watcher default backoff. Unit-test DTO mapping with fixture JSON objects (healthy pod, crashloop pod, pending pod, node, deployment with 0/1).
**Accept:**
- [ ] All 12 kinds stream snapshots; `kubectl scale`/`delete` reflects in emitted rows within ~1s.
- [ ] DTO unit tests cover the tone rules above (incl. `1/2` → warn, restarts 14 → err, Pending cpu/mem `—`).
- [ ] `watch-status.active` equals the number of live watcher streams (+ log streams later).
- [ ] Revoking RBAC for one kind (or simulating 403) leaves the other 11 streaming.

### Story 2.3 — Metrics + cluster status pollers
**Do:** Poll `metrics.k8s.io` every ~15s: PodMetrics → `pod-metrics { "ns/name": {cpuMillis, memBytes} }` (sum containers), NodeMetrics + node allocatable → `node-metrics` (percent per node) and cluster-wide cpu/mem %. Poll cluster status every ~10s: timed `/version` GET → `apiLatencyMs`; node Ready conditions → `nodesReady/nodesTotal`; emit `cluster-status { connected, version, apiLatencyMs, nodesReady, nodesTotal, cpuPercent?, memPercent? }`. If the metrics API is absent (404/ServiceUnavailable), stop emitting metrics events (UI shows `—`) but keep cluster-status alive; probe again every ~60s in case metrics-server appears.
**Accept:**
- [ ] With metrics-server: pod CPU/MEM values and cluster % arrive and look sane vs `kubectl top`.
- [ ] Without metrics-server: no metrics events, no error spam (one warn log), cluster-status still ticks.
- [ ] Killing the cluster mid-run flips `connected:false` within ~15s without panicking any task.

### Story 2.4 — TauriProvider (frontend wiring)
**Do:** Implement `TauriProvider` against the real commands/events (invoke `list_contexts`/`connect`; listen `resource-update`, `pod-metrics`, `node-metrics`, `cluster-status`, `watch-status`). Merge metrics into pod/node rows in the store (rows and metrics arrive on separate channels keyed by `ns/name`). Auto-connect to the kubeconfig current context on launch. Provider selection: demo env → Mock, else Tauri.
**Accept:**
- [ ] `npm run tauri dev` with a valid kubeconfig: live rows for all kinds appear in the store; pod CPU/MEM cells fill in after first metrics poll (or stay `—`).
- [ ] MockProvider and TauriProvider are interchangeable — no component imports either directly.

---

## Epic 3 — App shell UI

**Goal:** Sidebar, top bar, and status bar per Design §1/§2/§5, fully live.
**Exit:** Demo mode is visually indistinguishable from the prototype's shell (cluster switcher, nav with counts, ns dropdown, breadcrumb, status bar, watch footer).

### Story 3.1 — Sidebar frame + cluster switcher (Design §1)
**Do:** Sidebar 216px fixed, bg `#121214`, right border `#26262b`. Cluster switcher row per Design §1: button chrome (`#17171a`, border `#2e2e34`, radius 6, padding 8/10, hover border `#4a4a55`), 24×24 initials badge (`#34343c`, radius 5, mono 11 bold — initials = first two letters of cluster name uppercased, `FR` for freya), name 12.5px semibold `#ececf1` ellipsized, status line mono 10.5px `#70707a` with 6px dot — green `#9ece6a` + `connected · v1.31` when connected (version from cluster-status), amber + `connecting…`, red `#f7768e` + `disconnected`. Dropdown per spec (absolute, `#17171a`, border `#38383f`, radius 6, shadow `0 8px 24px rgba(0,0,0,.5)`): one row per kubeconfig context — dot green if active else `#57575f`, name 12.5px `#ececf1`, right tag mono 10px `#70707a` (kubeconfig cluster name), active row bg `#1b1b1f`, hover `#222227`. Selecting calls `provider.connect` (full switch flow hardened in E6.1). Menu closes on selection and outside click; opening it closes the ns menu (shared "one menu open" store slice).
**Accept:**
- [ ] Pixel-match vs prototype switcher (open and closed) in demo mode.
- [ ] Real mode lists actual kubeconfig contexts; status line reflects real connect lifecycle.
- [ ] Only one dropdown can be open app-wide; outside click closes.

### Story 3.2 — Nav sections + items with live counts
**Do:** Scrollable nav per Design §1: section headers (mono 10px uppercase, `letter-spacing:.12em`, `#57575f`) for Workloads / Network / Config / Cluster; items with glyph icon (11px, 14px col), label 12.5px, right count mono 10.5px `#70707a` = live row count from store. Active item: bg `#16233a`, 2px left border `#4d9fff`, label `#ececf1`, icon `#4d9fff`. Inactive: label `#8e8e98`, icon `#57575f`, hover bg `#1b1b1f`. Rows `margin:1px 8px; padding:5px 8px; radius:5px`. Click → set nav kind, **clear pod selection**, close menus. Icons/order/labels exactly per prototype `resourceDefs` (`◉ ▲ ≡ ⦿ ▸ ↻ / ⇄ ⇥ / ☰ ⚿ / ▢ ◫`).
**Accept:**
- [ ] Demo mode counts match prototype (Pods 13, Deployments 6, Nodes 6, Namespaces 5, …) and update live in real mode when resources are added/removed.
- [ ] Active/hover states pixel-match; switching kind clears any open detail panel.

### Story 3.3 — Watch footer
**Do:** Sidebar footer per Design §1: top border `#26262b`, mono 10.5px `#70707a`, 6px dot `#8e8e98` with `livePulse` 2s animation, text `watch: N streams active` where N = live `watch-status.active` (demo mode: 9).
**Accept:**
- [ ] N tracks watcher + log-stream count in real mode (opens a pod → N+1; close → N−1 — verifiable after E5).
- [ ] Pulse animation matches prototype timing.

### Story 3.4 — Top bar: breadcrumb + namespace dropdown (Design §2)
**Do:** Top bar 46px, bg `#101012`, bottom border `#26262b`. Left breadcrumb mono 12px: `<cluster> / <group> / <Kind>` — separators `#3a3a42`, kind `#ececf1` semibold, rest `#70707a`; group/kind track active nav (`workloads/Pods` etc.), cluster tracks active context. Right: namespace dropdown button (`padding:4px 10px`, `#17171a`, border `#26262b`, radius 5, mono 11px: `ns:` `#57575f`, value `#ececf1`, 8px `▼`); menu right-aligned min-width 170px, same chrome as cluster menu, rows mono 11px with blue `✓` (`#4d9fff`, 12px col) on the selected entry; options = `all` + live namespace list (from the Namespaces watcher / mock). Selection sets the store's ns filter and closes the menu.
**Accept:**
- [ ] Breadcrumb updates with nav and context; pixel-match both menus vs prototype.
- [ ] Namespace list is live (create a namespace in real mode → appears in menu).

### Story 3.5 — Status bar (Design §5)
**Do:** 26px bar, bg `#121214`, top border `#26262b`, mono 10px `#70707a`, 18px gaps: `● <cluster>` green `#9ece6a` when connected (red when not), `api: 42ms`, `nodes 6/6 ready`, `cpu 41%`, `mem 63%`, right-aligned `kubectl ctx: <context>`. All values from `cluster-status`; cpu/mem render `—` when metrics absent.
**Accept:**
- [ ] Demo mode string-for-string matches prototype; real mode values update every ~10s.
- [ ] Metrics-less cluster shows `cpu —  mem —` without layout shift.

---

## Epic 4 — Resource tables

**Goal:** The generic live table per Design §3 for all 12 kinds with namespace filtering.
**Exit:** Every nav kind renders its exact prototype columns with live data, correct tones, hover/selection, and the empty-filter state.

### Story 4.1 — Generic table component
**Do:** Table per Design §3: full-width, `border-collapse:collapse`, mono 11.5px. Sticky header (bg `#101012`, 10px uppercase 600, `letter-spacing:.1em`, `#57575f`, bottom border `#26262b`, padding `8px 14px`, nowrap, z-index above rows). Cells `padding:6px 14px`, bottom border `#1b1b1f`, nowrap. Row hover `#17171a`; selected row bg `#122036`. Cell rendering from `Cell{text,tone}`: tone→color map (`default #ececf1` for name col / `#a4a4ae` data, `muted #70707a`, `ok #9ece6a`, `warn #e0af68`, `err #f7768e`) + optional `● ` dot prefix on status cells. AGE cells format from `creationTs` via `lib/format.ts` and re-render on a 30s interval tick. Empty state: centered mono 12px `#57575f` — `no resources match filter`.
**Accept:**
- [ ] Header stays pinned under scroll; hover/selected backgrounds exact.
- [ ] Tone map is the only color path; AGE strings tick without full-table re-mounting jank.
- [ ] Empty state pixel-matches (trigger via a namespace with no resources).

### Story 4.2 — All 12 kinds wired + namespace filter
**Do:** Column definitions per kind exactly matching prototype `resourceDefs` (order and labels). Rows from store, filtered by ns (`all` bypasses; kinds without a namespace — Nodes, Namespaces — ignore the filter, per prototype's `!r.ns` behavior). Nav switch swaps columns/rows instantly (no fetch — data is already watched). Counts in nav (3.2) derive from the same store slice (pre-filter totals, matching prototype).
**Accept:**
- [ ] Demo mode: each kind's table matches the prototype row-for-row (spot-check Deployments `heimdall-auth 0/1` warn amber, Nodes green `● Ready`, Namespaces `Active` green).
- [ ] ns filter narrows Pods/Deployments/etc. and yields the empty state for `ns: default` + Pods (demo data), while Nodes/Namespaces stay full.

### Story 4.3 — Pods table: metrics + selection
**Do:** Pods columns NAME, NAMESPACE, READY, RESTARTS, CPU, MEM, AGE, STATUS. CPU/MEM cells from merged pod-metrics (`212m`, `486Mi` style via formatters), `—` (muted) when absent — always `—` for Pending pods. Row click → `selectedPod` (bg `#122036`), opens detail panel (E5), resets `activeTab` to logs and re-seeds the log stream on every pick (prototype behavior); clicking another pod re-seeds. Non-pod kinds: rows not clickable (no selection).
**Accept:**
- [ ] Real mode: CPU/MEM populate post-poll and update ~15s; demo mode matches prototype values.
- [ ] Selecting pods drives the detail panel; selection survives table re-renders (keyed by uid) and clears on nav/ns/context change.

---

## Epic 5 — Pod detail panel

**Goal:** The full Design §4 panel: streaming logs, YAML view/edit/apply, events.
**Exit:** Click any pod → live logs with all toolbar controls; YAML round-trips edits to the cluster; events list renders.

### Story 5.1 — Panel shell, header, tabs
**Do:** Panel 47% width min 520px, left border `#26262b`, bg `#101012`, opens when `selectedPod` set. Header per Design §4: 8px status dot (pod status color), name mono 13px semibold `#ececf1` ellipsized, `×` close button (24px square, radius 5, `#70707a`, hover bg `#222227` text `#ececf1`) → clears selection. Meta row (mono 10.5px `#70707a`, values `#a4a4ae`, padding-left 18px): `ns:`, `node:`, `age:` (live-formatted), status word in its status color. Tabs Logs/YAML/Events: 12px medium, `padding:7px 14px`, active `#ececf1` + 2px bottom border `#4d9fff` (margin-bottom −1px over the `#26262b` rule), inactive `#70707a`, hover `#ececf1`. Tab switch resets `yamlEditing`.
**Accept:**
- [ ] Open/close/selection behavior per prototype (×, nav switch, ns switch all close it).
- [ ] Pixel-match header + tabs for a Running and a CrashLoopBackOff pod (dot/status colors differ).

### Story 5.2 — Log streaming backend
**Do:** Rust commands `start_log_stream(ns, pod, container, tail?, since_time?) -> streamId` and `stop_log_stream(streamId)`. Use `Api::<Pod>::log_stream` with `LogParams { follow: true, timestamps: true, container: Some(..), tail_lines: Some(200), since_time }`. Spawn an abortable task per stream: read lines, parse per plan §3.1 (RFC3339 prefix → `HH:MM:SS.mmm`; level heuristic incl. JSON `"level"`; normalize DEBUG/INFO/WARN/ERROR, else empty), batch-emit `log-line:{streamId}` every ~80ms, emit `log-closed:{streamId} {reason}` on end/error. Register/unregister in the task registry (drives `watch-status`). Stop is idempotent; context switch and window close abort all streams. Unit-test the line parser (plain, klog, JSON, level-less, malformed-UTF8-lossy).
**Accept:**
- [ ] Streaming a chatty fixture pod delivers batched lines with correct ts/level split; a level-less printf app renders with empty level.
- [ ] `stop_log_stream` ends the task (watch count −1); starting with `since_time` returns only newer lines (verified in test).
- [ ] Deleting the pod mid-stream emits `log-closed` with a readable reason.

### Story 5.3 — Logs tab UI
**Do:** Toolbar per Design §4-Logs (padding 8/14, bottom border `#1b1b1f`): search field (flex-1, bg `#0a0a0c` — note: Design §4 README says `#0a0a0c` while the prototype HTML uses `#0d0d0f`; the README is canonical, use `#0a0a0c`; border `#26262b`, radius 5, `⌕` prefix `#57575f`, input mono 11px `#d2d2d8`, placeholder `filter logs…`); container cycler button (mono 10.5px `#a4a4ae`, `▣` + current container + 8px `▼`, cycles `podMeta.containers`, restarts stream + clears buffer on change); `ts` toggle (active border+text `#4d9fff`, inactive border `#26262b` text `#70707a`); follow/pause button — following: `⏸ pause` text `#9ece6a` border `#3a5f35` bg `#122015`; paused: `▶ follow` text `#e0af68` border `#5a4a2a` bg `#1f1a10`. Log area bg `#0a0a0c`, mono 11px, line-height 1.65, row hover `#151519`, rows `display:flex; gap:10px; padding:0 14px; white-space:pre-wrap`: ts col `#4c4c55` (hidden when ts off), level col 42px semibold (INFO `#4d9fff`, WARN `#e0af68`, ERROR `#f7768e`, DEBUG `#70707a`), message (`#a4a4ae`; ERROR lines `#f2a5b3`, WARN lines `#d8c39a`, `word-break:break-word`). **Behavior:** ring buffer caps at 200 lines (constant, drop oldest); auto-scroll to bottom on new lines *only while following*; **pause = stop_log_stream + stop autoscroll (buffer kept)**; follow = restart stream with `since_time` = last line's timestamp; search filters client-side on message+level (buffer untouched); opening a pod seeds via `tail_lines`; switching pod/container clears buffer and re-streams. Footer strip (mono 10px `#57575f`, top border `#1b1b1f`): `N lines` (filtered count) · `container: <name>` · `● streaming` green / `⏸ paused` amber.
**Accept:**
- [ ] Follow-on: viewport pins to bottom; scroll-up while following doesn't fight the user mid-frame but next line re-pins (prototype behavior). Pause: no new lines arrive at all (verify stream actually cancelled via watch count), scroll position frozen.
- [ ] Resume backfills from `since_time` without duplicating existing lines.
- [ ] Search narrows instantly; footer count reflects filtered lines; clearing search restores.
- [ ] Buffer never exceeds 200 lines; toolbar states pixel-match all four toggle combinations.

### Story 5.4 — YAML tab: view, edit, apply
**Do:** Backend: `get_yaml(kind=pods, ns, name)` → `serde_yaml` of the live object minus `metadata.managedFields`; `apply_yaml` → parse draft, `Api::replace` (preserve `resourceVersion` from the fetched object), map API errors (409 conflict, 422 validation, forbidden) to their message strings. Frontend per Design §4-YAML: toolbar with path mono 10.5px `#70707a` (`pods/<ns>/<name>.yaml`); read mode → `✎ Edit` button (11px, `#4d9fff`, border `#2a4a75`, hover bg `#12203a`); edit mode → `Cancel` ghost (border `#26262b`, `#a4a4ae`) + `Apply ⏎` (bg `#4d9fff`, text `#0d0d0f` semibold, hover `#7db8ff`). Read view: CodeMirror 6 (read-only, yaml lang) with a custom theme on the design tokens — bg `#0a0a0c`, mono 11.5px, line-height 1.6, line numbers right-aligned 30px col `#34343c`, keys `#a4a4ae`, punctuation/colon `#70707a`, plain values `#d2d2d8`, quoted strings `#9ece6a`, numbers `#e0af68`. Edit mode: same CodeMirror editable, 3px left border `#4d9fff`; Cancel discards draft; Apply → `apply_yaml`, on success exit edit mode + refetch, on failure stay in edit mode and show the API message in an inline error banner under the toolbar (mono 11px `#f7768e` on a dark red-tinted strip, dismiss on next edit). Fetch YAML lazily on first tab open per pod; refetch on pod change.
**Accept:**
- [ ] Read view highlighting matches the design colors (keys/strings/numbers spot-checked against prototype rendering).
- [ ] Real mode: edit a label → Apply → `kubectl get pod -o yaml` shows it; edit `resourceVersion` to garbage → inline API error, draft preserved.
- [ ] Demo mode: Edit/Cancel/Apply cycle mutates the mock cache like the prototype.

### Story 5.5 — Events tab
**Do:** Backend: `get_events(ns, name)` — core/v1 Events listed with field selector `involvedObject.name=<name>,involvedObject.namespace=<ns>`, mapped to `{type, reason, message, count, lastSeen}`, sorted newest-first. Frontend per Design §4-Events: vertical list gap 8, padding 10/14, cards bg `#121214` border `#26262b` radius 6 padding `9px 12px`; left type col 52px mono 10px semibold (Normal `#9ece6a`, Warning `#f7768e`); right: reason 12px semibold `#ececf1` + meta mono 10px `#57575f` (`2m · ×14` — age from lastSeen via formatter, count), message 11.5px `#a4a4ae` margin-top 2. Fetch on tab open (and on pod change while open); empty list → a muted `no events` line in the same style as the table empty state.
**Accept:**
- [ ] Fixture crashloop pod shows Warning `BackOff`/`Unhealthy` cards matching the design layout; healthy pod shows Normal Scheduled/Pulled/Started.
- [ ] Demo mode matches the prototype's two event sets exactly.

---

## Epic 6 — Context switching & resilience

**Goal:** Robust lifecycle: switching clusters, losing connectivity, degraded APIs.
**Exit:** Any context can be switched to at any time; failures degrade visibly but never wedge the app.

### Story 6.1 — Full context-switch flow
**Do:** Selecting a context in the cluster switcher: set UI to `connecting…` state, abort **all** backend tasks (watchers, log streams, pollers), clear store (rows, metrics, selection, log buffer, menus), `connect(context)`, restart watchers; switcher badge/initials + breadcrumb cluster + status-bar `kubectl ctx:` all update. Connect failure → `disconnected` state in switcher + red status bar dot, previous cluster's data stays cleared, other contexts remain selectable.
**Accept:**
- [ ] Switch between two kind clusters mid-log-stream: no stale rows/lines leak, watch count resets correctly, no orphan tasks (registry empty-then-repopulated).
- [ ] Switching to an unreachable context shows the error state and recovers when switched back.

### Story 6.2 — Degraded modes & stream errors
**Do:** (a) API unreachable mid-session: cluster-status flips `connected:false` → red dot + `disconnected` in switcher/status bar; watchers keep retrying (kube watcher backoff) and recover automatically; on recovery status flips back. (b) Log stream error/close: render the `log-closed` reason as a muted line in the log viewport and flip the follow button to paused state so the user can retry. (c) Metrics disappearing mid-run → cells fall back to `—` (no stale values >60s). (d) Ensure event-listener and interval cleanup on unmounts (no duplicate listeners after tab churn — test with rapid tab/pod switching).
**Accept:**
- [ ] `docker pause` on the kind node: app shows disconnected within ~15s, un-pause recovers with fresh snapshots, no restart needed.
- [ ] Killing a tailed pod shows the closed-reason line and paused state; re-selecting the replacement pod streams cleanly.
- [ ] 5 minutes of aggressive tab/pod/kind switching leaks no listeners/intervals (verify via devtools + watch count returning to baseline).

---

## Epic 7 — Verification, fidelity, packaging

**Goal:** Prove correctness against a real cluster, prove fidelity against the prototype, ship a build.
**Exit:** Fixture cluster script, passing test suite, pixel-pass checklist done, packaged app.

### Story 7.1 — Fixture cluster (kind)
**Do:** `dev/cluster/`: `kind-config.yaml` (single node fine), `up.sh` (creates cluster `k7s-dev`, applies manifests, optionally installs metrics-server with `--kubelet-insecure-tls` patch), `down.sh`. Manifests mirroring the prototype's world across namespaces `prod/staging/monitoring`: two multi-container deployments (app + `istio-proxy`-named sidecar + `log-shipper`), a 2-replica StatefulSet (`postgres` image), a **CrashLoopBackOff** deployment (container exiting 1 with ERROR-ish stderr), a **Pending** pod (impossible resource request), a chatty logger deployment (mixed-format lines: klog, JSON, plain, multi-level, ~2 lines/s), Jobs (completed), CronJobs, Services (ClusterIP + LoadBalancer + headless), an Ingress, ConfigMaps, Secrets.
**Accept:**
- [ ] `./dev/cluster/up.sh` from zero → app shows every kind populated, one red CrashLoopBackOff pod, one amber Pending pod, live logs from the chatty pod.
- [ ] Script is idempotent (safe to re-run) and `down.sh` removes the cluster.

### Story 7.2 — Pixel-fidelity pass
**Do:** Open `design/K8s Monitor.dc.html` in a browser beside the app in demo mode (identical data) at the same window size. Walk every section against Design §1–§5 and fix drift: sidebar (switcher open/closed, nav states, footer), top bar (breadcrumb, ns menu open), tables (pods + 3 other kinds, empty state), detail panel (all 3 tabs; logs in all 4 toolbar states; YAML read + edit; events for healthy + crashloop), status bar. Check: exact colors (eyedropper spot-checks), font sizes/weights, paddings/radii, hover states, selected states, pulse timing, scrollbars.
**Accept:**
- [ ] Side-by-side screenshots of the 6 key views (shell+pods, detail/logs, detail/yaml-read, detail/yaml-edit, detail/events, ns-menu open) are indistinguishable at a glance; any intentional deviation is listed and justified in the PR/commit description.

### Story 7.3 — Packaging & dev docs
**Do:** App icon (simple dark k7s glyph tile), `tauri.conf` bundle metadata, `npm run tauri build` producing a signed-or-adhoc macOS `.app`/`.dmg` that launches on a clean account (fonts bundled, no network fetches at startup, kubeconfig-less launch lands in a clean disconnected state with the contexts list still browsable if the file exists). Write the project `README.md`: prereqs, dev loop (`tauri dev`, demo mode), fixture cluster usage, test commands, architecture pointer to plan.md.
**Accept:**
- [ ] Built app launches from Finder on a machine/account without dev tooling; no white flash; offline launch clean.
- [ ] Launch with `KUBECONFIG=/nonexistent` shows a friendly disconnected state, not a crash.
- [ ] README dev loop verified by following it verbatim in a fresh clone.

### Story 7.4 — Final QA sweep
**Do:** Run the full matrix against the fixture cluster: every nav kind × ns filters; pod select/deselect churn; logs follow/pause/search/container-cycle/ts on the chatty + crashloop pods; YAML edit happy path + conflict + validation error; events on both pod classes; context switch to a second kind cluster and back; metrics-server present and absent; `cargo test`, `vitest`, `clippy`, `tsc` all green. File and fix anything found; leave known-issues notes in the README if legitimately deferred.
**Accept:**
- [ ] Full matrix executed with results noted in the PR/commit description; all suites green; zero console errors during the sweep.

---

## Story dependency graph (cross-epic)

```
E1.1 → E1.2 → E1.3 → (E2.*, E3.*, E4.*)
E2.1 → E2.2 → E2.3 → E2.4
E3.1..3.5 need E1.3 (store/provider); E3.5 needs E2.3 data in real mode
E4.1 → E4.2 → E4.3 (E4.3 metrics need E2.3/E2.4 in real mode)
E5.1 needs E4.3 (selection); E5.2 → E5.3; E5.4/E5.5 need E5.1
E6.* needs E2–E5 complete
E7.1 can start any time after E2.2 (useful from M2 onward); E7.2–7.4 last
```
