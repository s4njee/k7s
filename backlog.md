# k7s — Backlog (v2)

Prioritized next additions. The v1 backlog (B1–B13) is **shipped** on
`feat/backlog-qol` — detail panel for all kinds, filter bar, actions
(delete/scale/cordon), sorting, multi-container logs, keyboard nav, persisted
state, namespace pod counts, shell/exec, port-forwarding, and the pod Properties
panel — all verified against the live `freya` cluster. Numbering continues from
there.

Conventions are unchanged (see [tasks.md](tasks.md)): each item is
self-contained with **Do**/**Accept**, the DoD is clippy `-D warnings` +
`cargo test` + `tsc` + `vitest` + live or demo verification, colors come from
tokens only. Backend work follows the established patterns: commands for
one-shots, events for streams, abortable tasks registered in `ClientManager`
([src-tauri/src/kube/manager.rs](src-tauri/src/kube/manager.rs)).

---

## P0 — highest priority

### B14 — Cluster-wide Events view
*Why first: per-pod events expire after ~1h, so the per-pod tab is usually empty
(observed on freya) — the cluster feed is where problems actually surface.*

**Do:** Add an `events` pseudo-kind under the Cluster nav group (icon `☲`).
Backend: one more watcher in `spawn_all` on core/v1 Events, mapped to columns
TYPE, REASON, OBJECT (`kind/name`), NAMESPACE, AGE, COUNT, MESSAGE — TYPE toned
Warning→`err`, Normal→`ok`; sort Warnings first, then newest; cap the snapshot at
the latest ~500 to bound payloads. ns filter applies; rows are not clickable
(v1). Also: give the per-pod Events tab an empty-state hint ("no recent events —
events expire after ~1h").

**Accept:** *(shipped — commit `bd7a6a9`)*
- [x] The freya feed shows the live FailedMount/FailedScheduling warnings at the
      top and updates as they recur. Verified with `cargo run --example
      events_check`: 13 events, 11 warnings, warnings sorted first.
- [x] Event churn doesn't spam re-renders (existing debounce covers it); list
      stays ≤ cap; ns filter narrows.
- [x] Per-pod Events tab shows the TTL hint instead of a bare "no events".

### B15 — CRD support (dynamic resource kinds)
*Why: freya is CRD-heavy — Argo CD Applications, Traefik IngressRoutes, ARC
RunnerSets, helm.cattle.io charts. Without CRDs the app can't show half the
cluster's real state.*

**Do:** On connect, run API discovery (`kube::discovery::Discovery`) and emit a
`custom-kinds` event `[{group, kind, plural, namespaced}]` for CRD-backed
resources. Watch lazily: start a `DynamicObject` watcher only when the user opens
that kind (register/unregister commands) so hundreds of CRDs don't spawn watchers.
Generic columns NAME, NAMESPACE?, AGE. Frontend: a "Custom" nav section listing
discovered kinds (scrollable, filterable if long); detail (YAML/Events) rides the
existing DynamicObject path from B1. Watch count includes only open CRD watchers.

**Accept:** *(shipped)*
- [x] Argo CD `Application` and Traefik `IngressRoute` resources list live on
      freya; YAML opens; ns filter works. Verified with `cargo run --example
      crd_check`: 44 CRDs discovered, and a real reflector-backed dynamic watcher
      produces the 2 live Applications as table rows.
- [x] No CRD watcher runs until its kind is opened (watch-status proves it);
      closing/leaving the kind stops it.
- [x] RBAC-forbidden CRDs degrade like built-in kinds (empty table, no crash) —
      discovery itself also degrades to "no Custom section" if listing CRDs is
      forbidden.

*Note: discovery reads CustomResourceDefinitions directly rather than sweeping the
discovery API and blocklisting built-in groups — a CRD is by definition a custom
kind, so this needs no guessing and can't surface built-ins.*

### B16 — Port-forward Services (and forward UX)
*Why: B6 shipped pod forwarding only; the original spec included Services, and
forwarding a Service is the common case ("give me grafana").*

**Do:** Backend: for a Service ref, resolve selector → first Ready pod, then
reuse the pod forward path; map named targetPorts to the container port. Add the
Forward… action to Service rows' detail (ActionsMenu `canForward` for
`services`). UX: after starting a forward, copy `localhost:PORT` to the clipboard
and show it in the forwards strip immediately; forward errors (pod gone,
connection refused per-connection) surface in the strip item as a red tone.

**Accept:** *(shipped)*
- [x] Forwarding a Service opens a working local tunnel without picking a pod
      manually. freya has no `grafana`, so verified with `cargo run --example
      svc_forward_check` against `csearch-redis`: resolved to a Ready pod and a
      Redis PING through the tunnel returned `+PONG`.
- [x] Named targetPort services resolve correctly (`csearch-redis` 6379 →
      `"redis"`); numeric remaps too (`argocd-server` 80 → 8080); selector-less
      Services (`kubernetes`) and unpublished ports fail with readable messages.
- [x] Stopping works; context switch kills all forwards (existing reset path).

*Note: a Service forward follows one pod and does not load-balance — Kubernetes
has no service-level forward primitive, so `kubectl port-forward svc/x` behaves
the same way.*

### B17 — Persist imported kubeconfigs
*Why: deferred from B11 — imported contexts vanish on relaunch, which makes the
import feature feel broken for daily use.*

**Do:** Extend `Prefs` with `importedFiles: string[]`. On boot (TauriProvider
path only), re-run `import_kubeconfig` for each saved path before the initial
`listContexts` merge; drop paths that no longer parse (with a console warning,
not an error). Save whenever an import succeeds.

**Accept:**
- [ ] Import a kubeconfig, relaunch → its contexts are still in the switcher and
      connectable.
- [ ] Deleting the file then relaunching drops it silently; default-kubeconfig
      contexts always win name collisions (existing merge rule).

## P1 — next

### B18 — Properties for more kinds
*Extend B13's panel beyond pods; same one-command pattern
([properties.rs](src-tauri/src/kube/properties.rs)).*

**Do:** Per-kind property gatherers, one at a time in this order:
**Deployments** (replica status, strategy, selector, owned ReplicaSets + their
pod counts, conditions), **Services** (selector, endpoints/EndpointSlices with
ready addresses → backing pod names, ports incl. nodePort), **Nodes** (conditions,
taints, capacity vs allocatable, kubelet/OS/kernel versions, addresses),
**PVC-view on StatefulSets** (volume claim templates + bound PVCs). Frontend: the
Properties tab shows for these kinds (POD_ONLY set becomes per-kind capability).

**Accept:**
- [ ] Deployment properties on freya show ReplicaSets + conditions; Service
      properties list ready endpoint pods; Node properties show taints and
      capacity/allocatable.
- [ ] Kinds without a gatherer simply don't show the tab (no dead tab).

### B19 — Shell UX polish
**Do:** Give the Shell tab its own container picker (small dropdown, defaults to
the first container) instead of sharing the logs cycler index; add a "reconnect"
affordance when the session ends (the `[reason]` line becomes a row with a
`↻ reconnect` button); keep scrollback on reconnect.

**Accept:**
- [ ] Multi-container pod: logs cycler and shell container choice no longer
      affect each other.
- [ ] After `exit` in the shell, one click reconnects; scrollback preserved.

### B20 — Drain node
*Finishes B3's stretch goal.*

**Do:** Backend `drain_node(name)`: cordon, then list pods on the node (skip
DaemonSet-owned and mirror pods) and create `Eviction`s; emit progress events
(`drain-progress:{node}` with evicted/total); respect failures (PDB 429s) by
reporting them rather than retry-looping. Frontend: Drain… in the node actions
menu with confirm + progress in the header banner.

**Accept:**
- [ ] Draining a freya worker cordons it and evicts non-DaemonSet pods; PDB
      blocks surface as a readable message; uncordon restores schedulability.

### B21 — Table virtualization
*Scale safety: freya's 71 pods are fine, but 2–5k-pod clusters will jank the
full-render table.*

**Do:** Windowed rendering for the resource table (e.g. `@tanstack/react-virtual`,
bundled locally): fixed row height (design rows are 28px), overscan ~20, sticky
header preserved, keyboard highlight (B10) keeps the highlighted row scrolled
into view. Ensure sorting/filtering still operate on the full dataset.

**Accept:**
- [ ] A synthetic 5k-row mock kind scrolls at 60fps with j/k navigation working;
      no visual change at freya's scale.

## P2 — quality of life

### B22 — Window state persistence
**Do:** `tauri-plugin-window-state` (size/position/monitor), gated out of demo
builds. **Accept:** relaunch restores window geometry.

### B23 — Settings panel
**Do:** A small settings surface (gear in the sidebar footer) for: log ring-buffer
cap, metrics/status poll intervals, default namespace filter, and the shell
command override. Persist via the existing Prefs file; live-apply where cheap.
**Accept:** changing the ring buffer cap visibly changes log retention without
restart; values survive relaunch.

### B24 — Dev launch hygiene
*We hit this: orphaned `tauri dev` watchers + a dead vite made the app silently
fall back to a stale bundled `dist/`, which looked like missing features.*

**Do:** Add `dev/run.sh`: kills prior k7s dev processes (match real process
names), frees port 1420, ensures a fresh `npm run tauri:dev`, and fails loudly if
vite dies. Delete `dist/` in dev (or add a visible "BUNDLED BUILD" badge when
`import.meta.env.DEV` is false but the app was launched via `tauri dev`… simplest:
just remove stale dist as part of the script). Document in README.

**Accept:**
- [ ] Running `dev/run.sh` twice never yields two app instances or a stale-dist
      window.

### B25 — Release CI
**Do:** GitHub Actions workflow on a macOS runner: install deps, run the full
test suite, `npm run tauri:build`, upload the `.app`/`.dmg` artifacts (the DMG
styling step works on runners with a GUI session; otherwise ship the .app zip).
Tag-triggered releases attach artifacts.
**Accept:** pushing a tag produces a downloadable build with all suites green.

### B26 — Helm releases view
*freya is k3s + Helm; Lens parity feature.*

**Do:** Parse `sh.helm.release.v1.*` Secrets (base64 → gzip → JSON) into a
"Helm" nav kind: NAME, NAMESPACE, CHART, APP VERSION, REVISION, STATUS, UPDATED.
Read-only v1 (no rollback). Detail shows the release's rendered manifest summary.
**Accept:** freya's traefik and any user charts list with correct
chart/version/status; secrets remain redacted elsewhere.

---

## Suggested order

B14 → B15 → B16 → B17 (P0, in order) → B18 → B19 → B20 → B21 → B22–B26 as
convenient. Only hard dependency: **B16** builds on B6's forward plumbing
(shipped); **B18** builds on B13's pattern (shipped).
