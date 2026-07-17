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

## P0 — highest priority — **all shipped**

*B14 → B17 are done and verified against freya. P1 (B18) is now the top of the
list; see [Suggested order](#suggested-order).*

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

**Accept:** *(shipped)*
- [x] Import a kubeconfig, relaunch → its contexts are still in the switcher and
      connectable. `list_contexts` now returns the merged list, and imports are
      restored *before* it is called.
- [x] Deleting the file then relaunching drops it silently; default-kubeconfig
      contexts always win name collisions (existing merge rule). Covered by
      `cargo test`: a missing/unparseable kubeconfig errors, which `restore_imports`
      turns into a drop, and the pruned list is what gets persisted.

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

**Accept:** *(shipped)*
- [x] Deployment properties on freya show ReplicaSets + conditions; Service
      properties list ready endpoint pods; Node properties show taints and
      capacity/allocatable. Verified with `cargo run --example properties_check`,
      which gathers all five kinds off live objects and asserts those sections.
- [x] Kinds without a gatherer simply don't show the tab (no dead tab) —
      `KINDS_WITH_PROPERTIES` gates it, and a vitest asserts every listed kind
      really has a gatherer.

*Note: rather than a DTO + renderer per kind, gatherers return a generic section
document (field grid / table / chips) that the frontend renders for any kind — so
B18's remaining kinds, and future ones, are backend-only additions.*

### B19 — Shell UX polish
**Do:** Give the Shell tab its own container picker (small dropdown, defaults to
the first container) instead of sharing the logs cycler index; add a "reconnect"
affordance when the session ends (the `[reason]` line becomes a row with a
`↻ reconnect` button); keep scrollback on reconnect.

**Accept:** *(shipped — needs a GUI pass to confirm)*
- [x] Multi-container pod: logs cycler and shell container choice no longer
      affect each other — the Shell tab holds its own choice.
- [x] After `exit` in the shell, one click reconnects; scrollback preserved (the
      terminal and the session now have separate lifetimes, so reconnecting
      rebuilds only the session).

### B20 — Drain node
*Finishes B3's stretch goal.*

**Do:** Backend `drain_node(name)`: cordon, then list pods on the node (skip
DaemonSet-owned and mirror pods) and create `Eviction`s; emit progress events
(`drain-progress:{node}` with evicted/total); respect failures (PDB 429s) by
reporting them rather than retry-looping. Frontend: Drain… in the node actions
menu with confirm + progress in the header banner.

**Accept:** *(shipped — the destructive path is deliberately unexercised)*
- [x] Cordons, then evicts non-DaemonSet pods; PDB blocks surface as a readable
      message; uncordon restores schedulability (existing action).
- [x] Selection rules verified **read-only** against freya with `cargo run
      --example drain_check`, which reports what a drain *would* do: of 54 pods,
      29 would be evicted and 25 skipped (DaemonSet-owned, completed jobs, a
      failed pod). No pod was evicted and no node cordoned — draining a live node
      is the operator's call, not a harness's.
- [ ] **Not verified:** an actual drain, and a real PDB 429. Unit tests cover the
      429 classification; the live path needs a cluster you're willing to disrupt.

### B21 — Table virtualization
*Scale safety: freya's 71 pods are fine, but 2–5k-pod clusters will jank the
full-render table.*

**Do:** Windowed rendering for the resource table (e.g. `@tanstack/react-virtual`,
bundled locally): fixed row height (design rows are 28px), overscan ~20, sticky
header preserved, keyboard highlight (B10) keeps the highlighted row scrolled
into view. Ensure sorting/filtering still operate on the full dataset.

**Accept:** *(shipped — the fps claim needs your eyes)*
- [x] A synthetic 5k-row mock kind exists to test against:
      `VITE_DEMO=1 VITE_STRESS=5000 npm run dev` pads the mock pods list to 5000.
- [x] j/k navigation works and keeps the highlight on screen (computed for
      windowed rows, which may not be in the DOM at all).
- [x] No visual change at freya's scale: tables under 200 rows render exactly as
      before, windowing off. That threshold isn't just caution — windowing forces
      `table-layout: fixed`, since auto layout sizes columns from the *rendered*
      rows and would re-jig them as you scroll.
- [ ] **Not measured:** the 60fps claim. The windowing math is unit-tested
      (`src/lib/virtual.test.ts`), but frame rate needs the app in front of you.

*Note: no dependency added — with a fixed row height the windowing is ~40 lines,
and `@tanstack/react-virtual` assumes absolute positioning that a `<table>` with
a sticky header doesn't give for free.*

## P2 — quality of life

### B22 — Window state persistence
**Do:** `tauri-plugin-window-state` (size/position/monitor), gated out of demo
builds. **Accept:** relaunch restores window geometry.

**Accept:** *(shipped)*
- [x] Relaunch restores window geometry — verified by seeding a distinctive
      1100x700 at (240,160), relaunching, and confirming the app restored it and
      saved it back unchanged (a failed restore would have re-saved the 1440x900
      default). Stable across three launches, with no HiDPI size-doubling.
- [x] Nothing to gate for demo: it runs as a plain browser page with no Tauri
      backend, so this code isn't in that build at all.

*Two things this needed beyond adding the plugin. `rust-version = "1.77"` was
stale enough that cargo silently resolved the plugin to a **v0.1.1 built for
Tauri v1** rather than complaining — the real requirement is 1.77.2 (our
toolchain is 1.94). And the plugin only saves when the app quits through Tauri,
which SIGTERM isn't — so `dev/run.sh` (B24) would have thrown the geometry away
every session, leaving B22 dead in exactly the workflow B24 standardised. The app
now saves on SIGTERM too.*

### B23 — Settings panel
**Do:** A small settings surface (gear in the sidebar footer) for: log ring-buffer
cap, metrics/status poll intervals, default namespace filter, and the shell
command override. Persist via the existing Prefs file; live-apply where cheap.
**Accept:** changing the ring buffer cap visibly changes log retention without
restart; values survive relaunch.

**Accept:** *(shipped)*
- [x] The ring-buffer cap applies immediately: shrinking it trims the existing
      buffer rather than waiting for the next line (covered by store tests).
- [x] Values survive relaunch — verified by seeding all five into prefs.json,
      running the app, and confirming it restored them and saved them back
      unchanged (a failed restore would have written the defaults back).
- [x] Poll intervals apply on next connect and say so in the panel; the shell
      override applies to the next shell opened. Both are read by the backend
      from the same prefs file, so there's one copy of the truth.

*This found a silent data-loss bug: `save_prefs` round-trips the frontend's
object **through the Rust `Prefs` struct**, and serde drops unknown fields — so
any frontend-only setting was deleted on the first save. `logBufferCap` and
`defaultNamespace` were being wiped while the backend's own three survived. The
struct is the schema of prefs.json, not just the part Rust reads; a new
frontend-only setting must be added there too.*

### B24 — Dev launch hygiene
*We hit this: orphaned `tauri dev` watchers + a dead vite made the app silently
fall back to a stale bundled `dist/`, which looked like missing features.*

**Do:** Add `dev/run.sh`: kills prior k7s dev processes (match real process
names), frees port 1420, ensures a fresh `npm run tauri:dev`, and fails loudly if
vite dies. Delete `dist/` in dev (or add a visible "BUNDLED BUILD" badge when
`import.meta.env.DEV` is false but the app was launched via `tauri dev`… simplest:
just remove stale dist as part of the script). Document in README.

**Accept:** *(shipped)*
- [x] Running `dev/run.sh` twice never yields two app instances or a stale-dist
      window — verified by running it against a live first instance: it reclaimed
      all four processes and came back to exactly 1 app / 1 vite / 1 listener /
      no `dist/`.
- [x] Fails loudly if vite dies: verified by killing vite under a running app —
      it names the stale-bundle risk and stops the app.
- [x] Never touches other projects: verified against a second Tauri app
      (`rstorrent`) and another project's vite, both untouched.

*Two bugs this found in its own first draft, both the very failure it targets:
signalling `npm` left vite **and** the app orphaned (they're grandchildren), and
the app binary can't be matched by path at all — cargo launches it as the
relative `target/debug/k7s`, so every absolute pattern silently matched nothing.
That second one is exactly the mistake that caused the original incident.*

### B25 — Release CI
**Do:** GitHub Actions workflow on a macOS runner: install deps, run the full
test suite, `npm run tauri:build`, upload the `.app`/`.dmg` artifacts (the DMG
styling step works on runners with a GUI session; otherwise ship the .app zip).
Tag-triggered releases attach artifacts.
**Accept:** pushing a tag produces a downloadable build with all suites green.

**Accept:** *(shipped — unverified on GitHub; this repo has no remote)*
- [x] Every command the workflow runs was executed locally, exactly as written:
      `pnpm install --frozen-lockfile`, typecheck, vitest, clippy `-D warnings`,
      `cargo test`, and the real `pnpm tauri build`, which produced a 6.3MB zipped
      `.app` that round-trips into a valid arm64 bundle.
- [x] DMG is best-effort (`continue-on-error`) per the note above; it builds here,
      where there's a GUI session.
- [ ] **Not verified:** the workflow running on GitHub. There is no remote to push
      to, so the YAML is validated and its commands are proven, but Actions itself
      has never executed it.

*The DMG step **deletes** `bundle/macos/k7s.app` after folding it into the image
("Cleaning …/k7s.app"), so the zip step has to come first. It does — and now says
so, because the failure only appears if someone reorders two steps that look
independent.*

*Uses pnpm, not npm: `node_modules` is pnpm's and `pnpm-lock.yaml` is the newer
file, so it's what these builds actually come from. `packageManager` in
package.json now pins the version for CI and corepack alike.*

### B26 — Helm releases view
*freya is k3s + Helm; Lens parity feature.*

**Do:** Parse `sh.helm.release.v1.*` Secrets (base64 → gzip → JSON) into a
"Helm" nav kind: NAME, NAMESPACE, CHART, APP VERSION, REVISION, STATUS, UPDATED.
Read-only v1 (no rollback). Detail shows the release's rendered manifest summary.
**Accept:** freya's traefik and any user charts list with correct
chart/version/status; secrets remain redacted elsewhere.

**Accept:** *(shipped)*
- [x] freya's releases list with correct chart/version/status — verified with
      `cargo run --example helm_check`: traefik (traefik-40.1.3+up40.1.0, v3.7.1,
      deployed), traefik-crd, and both ARC releases.
- [x] Read-only: no Delete action, and `apply_yaml` refuses — a release's YAML is
      a rendered manifest, so applying it would bypass Helm and desync the
      release from what Helm believes it deployed.
- [x] Secrets remain redacted elsewhere, *and* here: a chart that renders a
      Secret has its values redacted in the manifest view, since otherwise the
      Secrets view's redaction is just a door with a window next to it.

*Two traps in the storage format. **Every revision is its own Secret** — a release
upgraded five times has v1…v5 — so the view reduces to newest-per-release, as
`helm list` does; freya only has v1s, so that's covered by unit tests instead.
And the value is **double base64'd**: Helm writes base64(gzip(json)), which
Kubernetes then base64s again for transport. A test fixture that encodes only
once tests a decoder no cluster will ever feed — which is exactly the bug the
first draft of the tests had.*

*Known rough edge: freya's traefik-crd renders a 1.4MB manifest. It loads, but
the YAML tab is not virtualized (B21 only covers tables), so very large
manifests may feel heavy.*

---

## Added after v2

### B27 — Node metrics plots (node-exporter → plotly)
*Nodes show one CPU/MEM percentage and no history; node-exporter has the rest.*

**Do:** A Metrics tab on nodes plotting CPU busy %, memory used, network rx/tx,
load, and filesystem usage, scraped from the node's node-exporter and drawn with
plotly.js-basic-dist-min.

**Accept:** *(shipped — needs a GUI pass to confirm the charts render)*
- [x] Data reaches the app on freya: verified with `cargo run --example
      nodestats_check` — the exporter is found automatically, and samples read
      cpu 0.8–2.3%, mem 24.1% (16.0/66.4 GiB), tx ~194 KiB/s, load 3.12/3.53/3.70,
      21 filesystems.
- [x] Scraping is lazy: it runs only while a node's Metrics tab is open, and the
      sidebar's watch count includes it.
- [x] plotly is loaded on first use, so the main bundle stays 872KB and its 1.13MB
      chunk only downloads if you open the tab.
- [ ] **Not verified:** the charts themselves rendering, and the NotReady-node
      error state.

*The data source is the finding here. **Prometheus has no node metrics on freya**
— `up{job="node-exporter"}` is 0 for all three targets, whose IPs (.153/.118/.104)
no longer match the nodes (.156/.104/.118). And the **API server's pod proxy times
out** even for the Ready node. Only the port-forward path (B6's machinery) works,
so the plots are live-only: an exporter serves counters, not history, and there is
nothing to backfill from. Fixing Prometheus's scrape config is a cluster change,
not an app change — once it scrapes, a Prometheus-backed history mode is a
natural follow-up.*

---

## Suggested order

~~B14 → B15 → B16 → B17 (P0, in order)~~ **shipped** → B18 → B19 → B20 → B21 →
B22–B26 as convenient. Only hard dependency: **B18** builds on B13's pattern
(shipped).

*B24 (dev launch hygiene) is worth pulling forward: the stale-dist trap it
describes bit us again while verifying B14.*
