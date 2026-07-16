# k7s — Feature backlog

Post-v1 features, roughly ordered by payoff-to-effort. Each item is scoped like the
stories in [tasks.md](tasks.md): self-contained, with pointers into the codebase and
acceptance criteria. The global Definition of Done from tasks.md applies (clippy
`-D warnings`, `cargo test`, `tsc`, `vitest`, demo-mode or fixture-cluster
verification, no hardcoded hex — tokens only).

Architecture refresher: the UI talks to a `DataProvider` seam
([src/providers/types.ts](src/providers/types.ts)) with Mock and Tauri
implementations; the Rust backend owns per-connection tasks in `ClientManager`
([src-tauri/src/kube/manager.rs](src-tauri/src/kube/manager.rs)) and emits
row-DTO snapshots ([src-tauri/src/kube/watchers.rs](src-tauri/src/kube/watchers.rs),
[dto.rs](src-tauri/src/kube/dto.rs)). New backend features should follow the same
patterns: commands for one-shots, events for streams, abortable tasks registered
with the manager.

---

> **Progress:** B1, B2, B3, B5, B12 done (branch `feat/backlog-qol`).

## B1 — Detail panel for all resource kinds
*The design handoff names this the natural follow-up ("extending YAML/Events to all
kinds"). Pods keep their Logs tab; every other kind gets YAML + Events.*

**Do:**
- Backend: generalize `get_yaml` / `apply_yaml` / `get_events`
  ([src-tauri/src/commands.rs](src-tauri/src/commands.rs)) beyond `kind == "pods"`.
  Either match per kind to the typed `Api<K>` (12 arms, reuses existing imports) or
  use `kube::api::DynamicObject` with an `ApiResource` looked up per kind. Strip
  `managedFields` as today. Events field-selector works for any involvedObject.
- Frontend: allow row click → detail for all kinds. Non-pod rows need a generic
  header (name, ns, age, first status-ish cell) — extend `Row` with an optional
  generic meta or derive from cells. Tab strip shows YAML/Events only (Logs stays
  pods-only). `selectedPod` becomes `selectedRow` in the store; keep the log-stream
  hooks gated on `pod != null`.
- Mock: reuse the YAML generator for pods; add a small generic YAML stub for other
  kinds so demo mode demonstrates the flow.

**Accept:**
- [ ] Clicking a Deployment/Service/ConfigMap row opens the panel with YAML + Events.
- [ ] Editing a Deployment's replica count via YAML Apply scales it (fixture cluster).
- [ ] Pods still show all three tabs; Secrets YAML is reachable but this is a
      deliberate decision point — either render values or redact `data:` (pick one,
      document it in docs/verification.md).
- [ ] Selection/clear behavior (nav switch, ns switch, ×) works for every kind.

## B2 — Table filter bar
*A `⌕` name filter above the table, like the log search.*

**Do:** Add `tableFilter` to the store (cleared on nav change). Render a search
field above [ResourceTable](src/components/table/ResourceTable.tsx) styled like the
logs toolbar search (bg `--bg-terminal`, border `--border-default`, mono 11px,
placeholder `filter…`). Filter rows client-side on name (case-insensitive substring)
inside the existing `useMemo` alongside the ns filter. Empty result reuses
"no resources match filter". Keyboard: `/` focuses it, `esc` clears+blurs (coordinate
with B11).

**Accept:**
- [ ] Typing narrows rows live across all kinds; count in the nav stays pre-filter.
- [ ] Clearing restores; nav switch resets the filter.
- [ ] Pixel-consistent with the logs search field.

## B3 — Resource actions (delete pod, scale, cordon/drain)
*First mutations beyond YAML apply. Each is one command + a confirm.*

**Do:**
- Backend commands: `delete_pod(ns, name)` (`Api::<Pod>::delete`),
  `scale(kind, ns, name, replicas)` (patch the scale subresource for
  Deployments/StatefulSets), `set_cordon(node, bool)` (patch `spec.unschedulable`).
  Drain = cordon + evict pods (`create` an `Eviction`) — mark drain optional/stretch.
- Frontend: an actions affordance in the detail header (e.g. a `⋯` menu styled like
  the dropdowns) and/or row context menu. Destructive actions get an inline confirm
  (small menu row "confirm delete?" pattern — no browser `confirm()`).
- Errors surface like YAML apply errors (inline strip, `--status-err`).

**Accept:**
- [ ] Delete pod: pod vanishes, replacement appears via watch (fixture cluster).
- [ ] Scale deployment 1→3: table READY updates live; scale back down works.
- [ ] Cordon node: Nodes table STATUS shows the change; uncordon restores.
- [ ] Every action asks for confirmation and reports API errors inline.

## B4 — Shell / exec into containers
*The flagship Lens feature. Fourth detail tab: Shell (pods only).*

**Do:**
- Backend: `kube`'s `Api::<Pod>::exec` with `AttachParams { stdin: true, tty: true,
  stdout: true }` (needs the `ws` feature — already enabled in Cargo.toml). Spawn an
  abortable task per session registered in `ClientManager` (counts toward
  `watch-status`). Wire stdin/stdout over Tauri: emit `shell-out:{id}` batches;
  command `shell_in(id, data)` + `shell_resize(id, cols, rows)` + `stop_shell(id)`.
- Frontend: add `xterm` (bundled locally, themed with tokens: bg `--bg-terminal`,
  fg `--text-body`, cursor `--accent`). New Shell tab with a container picker
  (reuse the cycler) and shell fallback list (`/bin/bash` → `/bin/sh`).
- Mock: a tiny fake echo shell so demo mode renders the tab.

**Accept:**
- [ ] `ls /` in a fixture pod returns output; ctrl-C works; resize reflows.
- [ ] Closing the tab/panel or switching pods kills the exec session (watch count
      returns to baseline).
- [ ] A pod without bash falls back to sh; a failed exec shows the API error inline.

## B5 — Column sorting
*Click a header to sort; click again to reverse.*

**Do:** Extend `Cell` with an optional `sort` value (number | string) populated by
the Rust mappers ([mappers.rs](src-tauri/src/kube/mappers.rs)) and the mock: ages
sort by creation timestamp, READY by fraction, CPU/MEM by the overlay numbers
(sort on the merged row, post-overlay), plain text lexicographically. Store
`sortCol/sortDir` per kind (reset on nav change is acceptable v1). Header shows a
`▲/▼` glyph in `--accent` on the active column; unsorted default preserves server
order.

**Accept:**
- [ ] Sorting Pods by RESTARTS puts the crashloop pod first; AGE sorts by real
      duration not string; CPU sorts numerically with `—` last.
- [ ] Direction toggles; indicator matches; other kinds sort too.
- [ ] Live watch updates keep the chosen order.

## B6 — Port-forwarding
*"Forward…" on pods/services + a manager strip listing active forwards.*

**Do:**
- Backend: `Api::<Pod>::portforward` (kube `ws` feature); bind a local
  `tokio::net::TcpListener` (port 0 = auto) and pump bytes between local conns and
  the forward stream. Task per forward in `ClientManager` (shows in watch count).
  Commands: `start_port_forward(ns, pod, remote_port, local_port?) -> {id, localPort}`,
  `stop_port_forward(id)`, `list_port_forwards()`. For Services, resolve a backing
  pod first (selector → first Ready pod).
- Frontend: action in the detail header; active forwards listed in a small section
  above the status bar or in the detail meta row (`localhost:54321 → 8080` mono,
  `×` to stop). Persist nothing — forwards die with the app.

**Accept:**
- [ ] Forwarding the fixture grafana pod's port then `curl localhost:<port>` works.
- [ ] Stopping the forward closes the listener; killing the pod ends it with a
      surfaced reason; context switch kills all forwards.

## B7 — Multi-container interleaved logs
*An "all containers" option in the container cycler.*

**Do:** Backend: allow `start_log_stream` with `container: null` → spawn one inner
stream per container, tag each parsed line, merge into one batch channel
(extend `LogLine` with optional `container`). Frontend: cycler gains an `all`
option (first position); when active, render a container tag column (mono,
`--text-faint`, fixed width, before the level column) and disable `sinceTime`
resume nuance if needed (resume per-container using the shared anchor is fine).
Ring buffer unchanged (200 total).

**Accept:**
- [ ] `all` on the fixture valkyrie-api pod interleaves 3 containers, each line
      tagged; filter/search still applies; pause/resume works.
- [ ] Per-container selection still behaves exactly as today.

## B8 — CRD support (dynamic resource kinds)
*Discover API groups; browse custom resources.*

**Do:** Backend: on connect, run API discovery (`kube::discovery::Discovery`),
collect CRD-backed resources (or read `CustomResourceDefinition`s), and emit a
`custom-kinds` event `[{group, kind, plural, namespaced}]`. Watch lazily: only
start a `DynamicObject` watcher when the user opens that kind (register/unregister
via commands) to avoid watching hundreds of CRDs. Generic columns: NAME,
NAMESPACE?, AGE. Frontend: a new "Custom" nav section listing discovered kinds
(scrollable), reusing the generic table; detail (YAML/Events) rides on B1's
DynamicObject path.

**Accept:**
- [ ] Install any CRD in the fixture cluster (e.g. a toy one in dev/cluster) +
      create an instance → it appears under Custom and lists live.
- [ ] Kinds without instances show an empty table, not an error; RBAC-forbidden
      CRDs degrade like built-in kinds.
- [ ] No CRD watchers run until their kind is opened (watch count proves it).

## B9 — Cluster-wide Events view
*A top-level "what's wrong right now" feed under the Cluster nav group.*

**Do:** Add an `events` pseudo-kind: nav item (icon `⚠` or `☲`) under Cluster.
Backend: watch core/v1 Events cluster-wide (one more watcher in `spawn_all`),
mapping to columns TYPE, REASON, OBJECT (`kind/name`), NAMESPACE, AGE, COUNT,
MESSAGE — TYPE toned Warning→`err`, Normal→`ok`. Sort Warnings first, then newest.
Cap the snapshot (e.g. latest 500) to bound payloads. ns filter applies. Row click
could jump to the involved object (stretch).

**Accept:**
- [ ] Fixture cluster shows the crashloop's BackOff/Unhealthy Warnings at the top,
      updating live; ns filter narrows.
- [ ] Event churn doesn't spam re-renders (debounce already covers this) and the
      list stays ≤ cap.

## B10 — Keyboard navigation
*k9s-style keys; no visible UI change except a focus ring.*

**Do:** A `useKeyboardNav` hook at App level (ignores keys when an
input/textarea/CodeMirror has focus): `j/k` or `↓/↑` move a highlighted row
(`--bg-hover` outline; Enter opens detail for clickable rows), `/` focuses the
table filter (B2) or log search when the Logs tab is active, `esc` closes menus →
clears filter → closes detail (in that order), `[`/`]` or `1/2/3` switch detail
tabs, `gg/G` jump top/bottom. Document the map in README.

**Accept:**
- [ ] Full flow without a mouse: filter pods, arrow to the crashloop pod, Enter,
      switch to Events, esc back out.
- [ ] Typing in any input never triggers navigation; keys do nothing harmful when
      the table is empty.

## B11 — Persisted state across launches
*Reopen where you left off.*

**Do:** Add `tauri-plugin-store` (or a tiny JSON file in `app_config_dir` written
via a `save_state` command). Persist: last context, nav kind, namespace filter,
`showTimestamps`, imported kubeconfig paths (re-import them on boot so their
contexts reappear — extend the imports registry to load at startup). Restore in
`useBootstrap` before auto-connect; fall back cleanly if the saved context no
longer exists. Demo mode: skip persistence entirely.

**Accept:**
- [ ] Quit/relaunch restores context, kind, ns filter, and imported contexts.
- [ ] A stale saved context (deleted from kubeconfig) falls back to
      current-context with no error loop.
- [ ] Demo mode behavior unchanged.

## B12 — Namespaces table: real pod counts
*Replace the `—` PODS column stub.*

**Do:** In Rust, the namespace mapper can't see pods; do the join where both
snapshots exist. Options: (a) frontend — derive counts in `ResourceTable` from
`rows.pods` when rendering the namespaces kind (simplest, live, zero backend work);
(b) backend — share the pod reflector store with the namespace watcher. Prefer (a);
note that counts are of *watched* pods (all, since watchers are cluster-wide).
Mock data already carries counts — keep demo values matching the prototype.

**Accept:**
- [ ] Namespaces table shows live pod counts summing to the Pods nav count.
- [ ] Creating/deleting a pod updates its namespace's count within ~1s.
- [ ] Demo mode still shows the prototype's numbers (7/2/2/2/0).

---

## Suggested order

B2 → B5 → B12 (small, immediate QoL) → B1 (unlocks B8's detail path) → B3 → B10 →
B9 → B7 → B11 → B4 → B6 → B8. Adjust freely — only real dependency: **B8 depends on
B1** (DynamicObject YAML/Events), and **B10's `/`-to-filter depends on B2**.
