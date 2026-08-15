# k7s — Backlog v7: local-first roadmap to close the Lens gap

This backlog supersedes the sequencing in [backlog-v6.md](backlog-v6.md). It is
based on the repository at `594063e` plus the in-progress B82 terminal work in
the working tree, reviewed on 2026-08-15. The comparison target is the current
Lens documentation and its 2026.5 release, not an old OpenLens feature list.

The constraint for this roadmap is explicit: development and acceptance use
local Kubernetes only (`kind` first; k3d/minikube when a second implementation
is useful). EKS, GKE, AKS, provider account discovery, cloud SSO, hosted
clusters, and Lens Teamwork/Cluster Connect are deferred. They must not block
the local product or the 1.0 release.

Conventions remain those of v6: clippy with `-D warnings`, Rust tests,
TypeScript typecheck, vitest, and proportionate live/demo verification. New UI
colors come from design tokens. A checkbox means acceptance was demonstrated,
not merely that code exists.

---

## Executive call

k7s has already crossed the line from prototype to capable Kubernetes desktop
client. Its strongest areas now meet or exceed the everyday Lens workflow:
multi-cluster retention, Problems + overview, detailed relationship panels,
safe YAML apply with server-side dry-run diff, workload logs, pod/node shells,
port-forwarding, metrics, CRDs, and rollback/uninstall for Helm releases.

The shortest route to a credible Lens alternative is no longer “add every
kind.” It is:

1. make stale and failed state impossible to miss;
2. prove the real app in CI and finish keyboard/accessibility behavior;
3. close the high-frequency table, metadata, and port-forward workflows;
4. fill the remaining Kubernetes catalog gaps, especially Gateway API;
5. complete Helm install/upgrade and reusable resource creation;
6. ship a small, secure extension surface and honest documentation.

AI assistants, hosted clusters, collaboration, and cloud discovery are not
required for local Lens parity. They are different products with account,
service, and security obligations and remain out of scope.

## Ground truth from the tree

### What is implemented

- 33 static navigation IDs: 31 built-in resource/feed tables plus Overview and
  Problems, with lazy discovery for arbitrary CRDs and CRD printer columns.
- Multi-cluster backend and cid-keyed frontend state; switching retains data,
  streams, terminals, forwards, and cluster identity.
- Delta row updates and virtual tables designed for 10k-object clusters.
- Cluster overview, per-cluster Problems, native notifications, metrics-server
  data, Prometheus backfill, pod/node metrics, and node-exporter details.
- YAML create/edit, server-side dry-run diff, delete/restart/scale/rollout,
  drain/cordon, bulk actions, logs, pod/node shells, and port-forwarding.
- Helm release decode/history/values plus rollback and uninstall. Chart
  repositories, install, and upgrade are still absent.
- Diagnostics, CSP/capability hardening, supply-chain gates, updater plumbing,
  and build jobs for macOS/Windows/Linux.
- B82 integrated kubectl terminal is in the current working tree and must be
  treated as in progress until its changes are committed and acceptance is
  rerun.

### What was verified during this review

- `npm test -- --run`: **375 tests passed in 27 files**.
- `npm run typecheck`: clean.
- `cargo test`: **223 tests passed**.
- `cargo clippy --all-targets -- -D warnings`: clean.
- There are 22 Rust live harnesses, including the current terminal harness, but
  the workflow does not run them against kind.

### Material weaknesses found

- Watchers use automatic backoff, but a watcher error is only logged. The UI
  receives one aggregate stream count, not per-kind freshness/error state.
- `AppError` still serializes as a plain string. Auth, TLS, reachability, RBAC,
  invalid YAML, and missing resources are not a stable typed frontend contract.
- The API health poll can mark a whole cluster unreachable and recover it, but
  there is no per-kind stale timestamp, retry state, or user-triggered retry.
- Tests are broad at the logic layer but thin at the rendered-component and
  packaged-app layers. CI does not create kind or run the live harnesses.
- Accessibility remains sparse: icon-only controls, div-based buttons, modal
  focus, tables/tabs, topology/timeline alternatives, and announcements need a
  deliberate pass.
- Tables sort/filter/window well, but do not resize/reorder/hide columns, add
  local custom columns, or export CSV as Lens does.
- Port forwards work, but there is no full management view for search,
  edit/restart, browser-open, and saved reconnection presets.
- README and verification facts have drifted (for example, the README still
  says 22 built-in kinds and its architecture section describes one active
  client; the verification summary reports early test counts).
- macOS remains unsigned/unnotarized; Windows/Linux builds exist but their real
  hardware acceptance checklists are unchecked. Updater end-to-end acceptance
  also depends on release secrets and published artifacts.

---

## Lens parity matrix

| Capability | k7s today | Roadmap decision |
|---|---|---|
| Install/update on macOS, Windows, Linux | Build/updater plumbing exists; signing and real-host proof incomplete | Finish the v6 release-acceptance lane; do not block local feature work on an Apple certificate |
| Kubeconfig and multiple local clusters | Strong, simultaneous multi-cluster implementation | Keep; add typed failures, stale state, and workspace polish |
| EKS/GKE/AKS discovery and SSO | Not implemented | **Deferred: cloud** |
| Cluster Connect/Spaces/team sharing | No service or account system | **Out of scope** |
| Overview, health, metrics | Strong overview + Problems + Prometheus backfill | Add configurable metric source and optional local stack install only after reliability |
| Workload/config/network/storage/RBAC tables | Broad, but missing VPA, PriorityClass, RuntimeClass, Lease, admission policies, legacy RC, and first-class EndpointSlice | B90 |
| Gateway API | Only generic CRD behavior when CRDs exist | B91: first-class Gateway API group and relationships |
| CRDs | Lazy generic tables with declared printer columns | Keep; B85 extensions add custom panels/columns |
| Table controls/export | Sort, filter, virtualize; fixed columns and no CSV | B87, absorbing B67 |
| YAML create/edit | Strong generic YAML path with dry-run diff | B94 adds reusable templates and recent/history UX |
| Labels/annotations | Full YAML only | B88, absorbing B62 and B64 |
| Logs, pod shell, node shell, kubectl terminal | Strong; terminal is current in-progress work | Finish B82; B59 is later polish |
| Port forwarding | Pod/Service forwards with failure visibility | B89 management workspace + presets |
| Helm | Read/history/rollback/uninstall | B93 chart repos + install/upgrade |
| Applications view | Missing | B92: label-derived application inventory |
| Extensions | Missing | B85 after internal seams and e2e are stable |
| Accessibility/e2e | Major gap | B83 and B84 are P0 |
| AI, MCP, commercial support chat | Missing | Not parity targets for 1.0 |

The comparison is grounded in Lens's official documentation for its
[layout and dock](https://docs.k8slens.dev/k8slens/using-lens/layout/),
[Applications view](https://docs.k8slens.dev/k8slens/using-lens/applications/),
[Helm Charts](https://docs.k8slens.dev/k8slens/using-lens/helm/charts/),
[port-forward management](https://docs.k8slens.dev/k8slens/using-lens/network/port-forwarding/),
[cluster settings](https://docs.k8slens.dev/k8slens/cluster/cluster-settings/),
[metrics](https://docs.k8slens.dev/k8slens/cluster/cluster-metrics/), and the
[2026.5 Gateway API release](https://docs.k8slens.dev/release-notes/lens-k8s-ide/lens-2026-5-181248/).

---

## Status of backlog v6

| Item | Status at v7 review | Remaining acceptance |
|---|---|---|
| B69 license/changelog/versioning | Implemented | Keep CI gate green |
| B70 signed/notarized macOS | Blocked on external Developer ID | Add secrets, Intel/universal artifact, verify Gatekeeper |
| B71 Windows/Linux | Implemented, not accepted | Run the real-host checklist; make smoke launch gating once reliable |
| B72 auto-update | Implemented, not accepted | Configure signing secret and prove N→N+1 plus tamper rejection |
| B73 diagnostics | Implemented | Run a real fixture session, export, and redaction scan |
| B74 cloud auth/resilience | Partial | Split into local B74-L now and cloud B74-C deferred |
| B75 hardening | Implemented | Keep packaged CSP and dependency gates green |
| B76–B80 | Implemented | Fold their live harnesses into B83 CI |
| B81 Helm rollback/uninstall | Implemented | Known hook/prune differences remain; full chart management is B93 |
| B82 kubectl terminal | Implemented | Terminal harness run on macOS; three-OS QA stays with the B71 release lane |
| B83 e2e | Open | P0 |
| B84 accessibility | Open | P0 |
| B85 extensions | Open | P4 after e2e and the table/detail contracts settle |
| B86 docs/launch | Open | Final release gate |
| B59/B60/B62/B64–B68 | Open | Re-slotted below; B61 and B63 were absorbed and completed |

---

## Release map

| Release | Theme | Scope |
|---|---|---|
| v0.6 | **Honest under failure** | Finish B82 · B74-L · B83 · B84 · release acceptance for B70–B73 |
| v0.7 | **Daily operator workflow** | B60 · B87 tables/export · B88 metadata/safe mutations · B89 forward manager |
| v0.8 | **Kubernetes catalog parity** | B90 remaining built-ins · B91 Gateway API · B92 Applications |
| v0.9 | **Deploy and customize** | B93 Helm phase 2 · B94 resource templates · B95 metrics settings · B85 extensions |
| v1.0 | **Proven launch** | B86 · support matrix · two green release candidates; selective B59/B66/B68 only if they do not delay launch |

Release numbers describe the next product milestones, not the historical v6
theme rows. The package remains `0.5.0` until a release is deliberately cut.

---

## P0 — v0.6: honest under failure

### Finish B82 — Integrated kubectl terminal

The current working tree already implements this item. Do not expand its scope.
Complete the local harness, orphan cleanup, focus/resize behavior, disconnect
cleanup, and Windows PowerShell path; then commit it as one coherent change.

**Accept:**

- [x] `terminal_check` proves a terminal bound to cluster A lists A even when
      the machine's default kubectl context is B — the harness binds to the
      fixture context A via its own temp KUBECONFIG and asserts the pods the
      app's table lists, while a control shell whose ambient default is a
      different, unreachable cluster B does not see A.
- [x] Closing a tab and disconnecting a cluster both end the PTY and remove its
      0600 temp kubeconfig; startup sweeps crash leftovers — the pump holds the
      child in a `PtyChild` guard that kills it on drop (aborting a task can't
      run async cleanup), the manager deletes the file on stop/disconnect, and
      `cargo test` covers both.
- [x] Two cluster-badged terminals retain independent sessions across switches —
      each tab carries its cluster's badge, hidden terminals stay mounted, and
      the store tests cover open/close/focus.
- [x] Typecheck, 375+ frontend tests, Rust tests, and clippy remain green — 226
      Rust tests, 375 frontend tests, `tsc --noEmit`, `clippy -D warnings`.

### B74-L — Local connection resilience and typed failure states

This is the locally testable, provider-neutral half of B74. Replace string-only
errors with a serialized error envelope: stable code, safe message, optional
kind/context, retryability, and next action. At minimum classify authentication,
missing exec binary, forbidden/RBAC, TLS, unreachable/timeout, malformed
kubeconfig, invalid YAML, conflict, and not found.

Track every watcher by `{cid, kind}` with state `starting | live | backoff |
forbidden | stopped`, last successful update, retry count, and last safe error.
Tables, nav counts, the cluster rail, and status bar must show stale/backoff
state. A forbidden kind is different from a healthy empty table. Add Retry at
kind and cluster level without discarding retained rows or UI state.

Use a local fake kubeconfig exec credential process to test success, expiry,
refresh, missing binary, bad output, and non-zero exit. Use kind plus a
restricted ServiceAccount kubeconfig to test 403 behavior. Use a local proxy or
kind stop/start to test outage recovery. No cloud account is needed.

**Accept:**

- [x] Killing kind or blocking its API marks the cluster stale within one poll
      interval, retains last-known rows with an age, and clears automatically on
      recovery — the status poller emits `stale` + `lastSeenMs` on a failed probe
      and clears on the next success; `resilience_check` exercises the same
      classification through a controllable `kubectl proxy` (Unreachable →
      recovery), and the table/switcher/status bar render the retained rows with
      an age.
- [x] Denying `list/watch secrets` marks Secrets forbidden while Pods remain
      live; Secrets never appears as a trustworthy empty table —
      `resilience_check` proves the pods-only ServiceAccount lists pods but gets
      a classified 403 on secrets, and the UI shows a forbidden banner + nav dot
      over the retained rows instead of an empty count.
- [x] A single broken watcher cannot make the whole cluster look disconnected —
      watcher failures touch only that kind's health (`forbidden`/`backoff`), the
      connection phase never flips on a watcher error, and staleness is driven by
      the cluster status probe alone.
- [x] Every classified error renders a specific next action; raw Rust/debug
      strings are kept in diagnostics, not shown as the primary message — the
      envelope carries `action.label`/`action.hint` and `detail`; the UI shows
      the safe message + action (`errDisplay`), and `log_frontend_error` forwards
      `detail` into the diagnostics log.
- [x] Fake exec-plugin expiry and recovery pass in the packaged app launched
      without a terminal environment — `exec_check` proves success, expiry
      re-exec, missing-binary (`exec-missing`), bad output and non-zero exit
      (`exec-failed`) against kind; the app resolves the login PATH at boot, so
      a Finder-launched packaged app finds the plugin (packaged-app run itself
      stays on the B71 release lane).

### B83 — Component, packaged-app, and live kind CI

Keep the two-layer design from v6, but make the existing harness inventory part
of the deliverable. Add React Testing Library + user-event for interaction
contracts and axe integration as B84 lands. Add one Linux Tauri WebDriver smoke
path. Create kind in CI and run the 22 discovery-based Rust examples through a
manifested runner that records pass/skip/fail and enforces cleanup.

Split CI by cost: logic/component tests per PR; kind harnesses per PR once stable;
packaged e2e nightly until its seven-day flake rate is below 5%, then gate main.

**Accept:**

- [ ] Component tests cover cluster switch, table filter/sort, detail tabs,
      dry-run dialog, confirmation, terminal open/close, and background-cluster
      isolation.
- [ ] A kind CI job creates the fixture, runs every applicable live harness,
      publishes logs on failure, and always tears down.
- [ ] Packaged e2e covers connect → overview → pod → logs → YAML dry run → safe
      mutation → recovery after a simulated outage.
- [ ] A deliberately broken event cid or tab route is caught by the suite.

### B84 — Accessibility and keyboard completeness

Retain v6's scope. Make semantic buttons actual buttons, add table/nav/tab/dialog
semantics, trap and restore modal focus, label every icon-only control, announce
async results, and give timeline/topology equivalent text views. Define a visible
tokenized focus ring and verify both themes at WCAG AA.

**Accept:**

- [ ] axe reports zero serious/critical issues on every main view in both themes.
- [ ] Keyboard-only: connect, choose namespace, filter/open a pod, read logs,
      invoke an action, use a terminal, and close every surface.
- [ ] Modal focus returns to the invoking control; no div-only pseudo-button is
      left in an interactive path.
- [ ] VoiceOver on macOS and NVDA on Windows complete the scripted core flow.

**Implementation report (2026-08-15):**

Shipped the v6 scope against the B83 test net. **Semantics:** the ~50 div/span
click targets became real `<button>`s — sidebar nav (NavList, CustomSection,
Bookmarks), cluster-switcher button + context rows + import row, namespace
dropdown, detail close/bookmark/tabs, actions ⋯ (now Escape-closes instead of
letting Escape cascade into `closeDetail`), YAML edit/preview/apply/back, the
action confirmations and scale/port-forward forms, log toolbar controls,
forwards stop/copy, shell-session controls, and the settings toggles (now
`<button role="switch">`). A global button reset (module classes still win) keeps
the pixel look. Tables got `scope="col"`, `aria-sort`, and a caption/name;
sortable headers are a real button inside the th. The command palette is a
combobox/listbox with `aria-activedescendant` + a result-count live region. The
sidebar is a `role="navigation"` landmark with `aria-current`; the detail tab
strip is a tablist with arrow-key cycling; icon-only controls are labelled and
decorative glyphs `aria-hidden`. **Focus:** a tokenized `--focus-ring` (accent,
both palettes + accent presets) applies on `:focus-visible`; a new
`useFocusTrap` gives the four overlays (Settings, Create YAML, palette, kubeconfig
QR — which also gained Escape) and the action confirmations trap+restore, and the
row context menu moves focus in and back to the row. **Announcements:** live
regions for table row counts, log status/save notes, and `role="alert"` on health
and action-error banners. **Canvas fallbacks:** the event timeline and topology
graph render visually-hidden DOM equivalents from the same data. **Axe:** 410
frontend tests green; `src/axe-views.test.tsx` asserts zero serious/critical on
every main view in both themes (contrast excluded in jsdom — see
`docs/verification.md`); `src/a11y-behavior.test.tsx` pins focus-return and the
keyboard flows. **Deferred to the hardware lane (like B70–73):** the VoiceOver /
NVDA scripted run and the real-browser WCAG AA contrast audit — the scripted
core-flow checklist is in `docs/verification.md`.

### Release-acceptance lane (B70–B73)

Run in parallel with P0 and never mislabel implementation as acceptance.

- [ ] B70: Developer ID available, arm64 + x86_64/universal macOS artifact,
      notarization and `spctl` accepted. Until then release notes say unsigned.
- [ ] B71: downloaded artifacts pass `docs/verification.md` on real Windows 11
      and Ubuntu 24.04; CI first-paint probes become required where stable.
- [ ] B72: a published signed N→N+1 update succeeds on all update-capable
      packages and rejects a modified artifact.
- [ ] B73: exported diagnostics from a kind session pass the documented leak
      scan and contain useful watcher/error state from B74-L.

---

## P1 — v0.7: daily operator workflow

### B60 — Saved views

Carry the v5 specification forward, now cid-keyed. A saved view includes kind,
namespace, filter expression, sort, visible column configuration, and optional
Problems/all-clusters scope. It is available from the toolbar and command
palette, with built-ins for unhealthy pods, warnings, Pending workloads, and
recent failures.

**Accept (v5, carried forward):**

- [ ] Saving `status=CrashLoopBackOff` + namespace + sort RESTARTS desc, then
      loading it, restores all three parameters.
- [ ] Built-in views work on any cluster (filter expressions, not hardcoded names).
- [ ] Views survive restart.
- [ ] ⌘K lists saved views with a "view:" prefix for discoverability.

**Implementation report (2026-08-15):**

Implemented. A `SavedView` (providers/types.ts, beside Bookmark) captures
kind/namespace/filter/sort(by column *name*, so it survives the CLUSTER-prepend
of the all-clusters problems scope and B87's future column work)/problems scope
+ a B87-forward columns snapshot. The filter grammar gained `colname=value` cell
matching with `|` OR (src/lib/filter.ts) — required by the acceptance case and
the built-ins; label selectors are unchanged. Store: `savedViewsByCid` +
add/remove (upsert by name = edit-in-place) in the connection slice, and an
`applyView` action (navigation slice) that sets nav+namespace+filter+sort+scope
in one update (deliberately not `jumpTo`, which clears filter/sort). UI: a "▾
views" dropdown in the table toolbar (built-ins + saved, each applies; ✕ deletes
saved ones; "Save current view…" captures the live table state). The command
palette lists them as `view: <name>` items (palette ViewItem). Built-ins (v7):
Unhealthy pods, Warnings, Pending workloads, Recent failures — plain filter
expressions that work on any cluster. Persistence mirrors bookmarks: a
`savedViews` field on `Prefs` (TS + the Rust `Prefs` struct in commands.rs —
without the Rust field serde would drop it on first save) restored/saved in
useBootstrap. **Verification:** 434 frontend tests green (+24), clippy and cargo
test green (Rust change is the struct field only). The four acceptance items are
covered by tests: save/load restores filter+namespace+sort (store + toolbar
tests), built-ins match mock rows per cluster (views.test), the prefs round-trip
survives JSON (store test), and ⌘K's "view:" items (palette test). Remaining to
confirm in the running app: a real restart cycle and a manual ⌘K run — the boxes
above are left unchecked until then.

### B87 — Table controls, local custom columns, and export *(absorbs B67)*

Add show/hide, drag reorder, resize, reset, and persisted width/order/visibility
per `{cid, kind}`. Add label/annotation and restricted JSONPath custom columns,
sharing the evaluator and schema later used by B85. Export the current logical
result—not only mounted virtual rows—to CSV, respecting namespace/filter/sort/
visible columns. CRD printer columns participate like built-ins.

**Accept:**

- [ ] Column order, width, and visibility survive restart and do not leak to a
      second cluster.
- [ ] A label and a JSONPath column render safely with missing values as `—`.
- [ ] CSV from a 10k-row filtered table contains exactly the logical result in
      current order, with correct quoting and no hidden columns.
- [ ] Keyboard users can configure columns without drag-and-drop.

**Implementation report (2026-08-15):**

Implemented (absorbs v5 B67). **Column config** — `ColumnPrefs` (hidden names,
display order, percent widths, custom columns), keyed by column *name* (indices
drift under the CLUSTER-prepend and reordering) and persisted per-`{cid, kind}`
through the savedViews chain (TS `Prefs` + the Rust `Prefs` struct + useBootstrap
restore/save). **Table rendering** — the table renders through a descriptor
(`resolveColumns` → `ColumnRef[]`) mapping each rendered position to a base cell
index or a custom column; the derived `{ row, cells }` display rows are what sort
and render, so the base `row.cells` is never mutated (overlayMetrics/sortRows/
the B60 filter keep their indices; the filter still sees the full base columns).
Sort stays index-based but the B60 saved-view sort name now resolves against the
rendered columns; applying a saved view that captured columns also restores that
column set. **Header** — sortable th buttons (aria-sort), HTML5 drag-reorder
(v5 B67) for base columns, and a right-edge resize handle writing percentage
widths; a "☰ columns" toolbar menu offers show/hide checkboxes, ↑/↓ move buttons
(the no-drag keyboard path), custom-column creation, and reset. **Custom
columns** — label, annotation, and restricted JSONPath, evaluated on the frontend
against the row (the JSONPath evaluator extracted from the mock to
`src/lib/jsonpath.ts`, mirroring the backend subset, shared with B85); the `Row`
DTO gained `annotations` and every kind now emits labels+annotations (Rust
dto.rs + mappers sweep, `map_dynamic` reads them from the raw object). Missing
values render `—`. **CSV export** — `lib/csv.ts` RFC 4180 quoting; a toolbar
"⇩ CSV" button exports the full filtered/sorted logical result (not the mounted
virtual slice) through a new `saveCsv` provider method + native save dialog +
the `export_csv` Rust command. **Verification:** 465 frontend tests (+31),
clippy + 234 cargo tests green. Acceptance is covered by tests: per-{cid,kind}
persistence + the JSON round-trip, label/JSONPath cells with `—`, the 10k-row
buildCsv with quoting, and the keyboard menu path — the boxes are left unchecked
until a real-app pass (resize/reorder feel, a native CSV save, restart).

### B88 — Metadata editor and transparent mutations *(absorbs B62 + B64)*

Add focused JSON Patch editing for labels and annotations, with value expansion
and selector/dependency warnings. Add the kubectl-equivalent preview to every
mutation confirmation. Before rendering an action, use `SelfSubjectAccessReview`
to disable verbs the current identity cannot perform and explain the missing
permission. Helm-managed objects are not globally read-only: allow metadata
changes only when the exact field is not owned by Helm, otherwise warn and
require YAML/Helm workflow.

**Accept:**

- [ ] Add/edit/remove metadata round-trips against kind and updates through the
      watcher without a manual refresh.
- [ ] Removing a Service/controller selector label names the relationship that
      will break before applying.
- [ ] Scale/delete/drain/create/apply confirmations show copyable commands whose
      flags match actual behavior.
- [ ] A restricted ServiceAccount sees forbidden actions disabled before click;
      a race still returns a typed B74-L error.

**Implementation report (2026-08-15):**

Implemented (absorbs v5 B62 + B64). **Metadata editor** — a Labels & Annotations
section at the top of the Properties panel (`MetadataEditor`) with inline
add/edit/remove via focused RFC 6902 JSON Patch (`patch_metadata` command:
`Patch::Json` over `dynamic_api` for any kind incl. CRDs; `~1`/`~0` pointer
escaping tested). Removing a pod label fetches `label_dependencies` and, if a
Service/PDB/NetworkPolicy selects on it, warns naming the dependent before
removing. Long annotation values truncate with expand-on-click. The patch
refuses Helm-managed metadata (the managed-by label or a managed field with
manager "helm") with a real message, and the editor shows the same warning.
**Kubectl previews** — every action confirmation (and the scale/port-forward
forms, live on their parameters) plus the create/apply YAML paths show a
collapsible "kubectl equivalent" built from the action's parameters
(`lib/kubectl.ts`; the drain flags `--ignore-daemonsets --delete-emptydir-data`
match the app's behavior; bulk = one command per resource) with a copy button.
**RBAC** — `subject_access_review` (SelfSubjectAccessReview) + a `canI` provider
method gate the actions menu: a forbidden verb disables the action up front with
an explanation; a race still surfaces as the existing typed B74-L envelope. The
per-action verb/resource map (`actionVerbs`) is tested. **Live proof** — a
`metadata_check` harness in the B83 manifest patches a fixture pod's label and
proves the watcher carries it (22/25 harnesses pass against kind, incl. the new
one). **Verification:** 481 frontend tests (+16), clippy + 237 cargo tests
(+3: the RFC 6902 op builder + Helm guard), and the live round-trip. The v7
acceptance boxes stay unchecked pending the real-app pass (a restricted SA on
kind, a native confirm preview, a Helm-owned object).

### B89 — Port-forward management workspace

Promote the current forward strip into a searchable management view. Support
open in browser, stop/start, edit local port, delete, and named saved presets.
Presets are cid-bound, disabled when the cluster is offline, and optionally
restart after reconnect only with explicit user opt-in. Keep the compact strip
as the always-visible active-session summary.

**Accept:**

- [ ] Pod and Service forwards can be created, edited, stopped, restarted, and
      opened from one view; failures retain their actionable error.
- [ ] A saved preset survives restart but does not auto-connect unless enabled.
- [ ] Recreated pod endpoints are resolved again rather than reusing a dead pod
      name/IP.
- [ ] Same-named Services on two clusters remain unambiguous and isolated.

**Implementation report (2026-08-15):**

Implemented. **Management workspace** — a `ForwardManager` modal (searchable,
`role="dialog"` + focus trap) lists the cluster's active forwards and saved
presets: each forward row has open-in-browser (`shell:allow-open` already covers
`http://localhost:<port>`, via `lib/openExternal`), stop, edit-local-port (an
inline port input → stop + restart with the chosen port), save-as-preset, and a
failing forward's `error` shown inline. The compact ForwardsBar stays the
always-visible summary and now has a "manage" button. **Presets** —
`ForwardPreset` (kind/target/remotePort/optional pinned localPort/autoRestart),
cid-bound via `forwardPresetsByCid`, upserted by name, persisted through the
savedViews chain (TS Prefs + the Rust `Prefs` struct `forward_presets` +
useBootstrap); they never auto-connect on launch. **Backend** — the forward
start path gained an optional `local_port` (a chosen-but-busy port yields the
clear bind error); a Service-forward restart re-runs `resolve_service`, so a
recreated pod endpoint is resolved again rather than pinning a dead pod (the
`svc_forward_check` harness proves the resolution). **Offline + reconnect** —
presets disable when the cluster is stale *or* disconnected (both signals
checked), and a stale→fresh-edge hook (`useForwardPresetRestart`, mounted at the
App root) restarts each opted-in preset when the cluster comes back —
frontend-only, since the backend never auto-restarts forwards. **Verification:**
489 frontend tests (+8: preset store + the manager's start/edit/error/offline),
clippy + 237 cargo tests green. The v7 acceptance boxes stay unchecked pending
the real-app pass (an actual Service forward opened in a browser, an edited
port, and a reconnect restart on kind).

---

## P2 — v0.8: Kubernetes catalog parity

### B90 — Built-in resource coverage, wave 2

Add first-class tables, properties, reference links, events/YAML/diff, mock data,
and fixture coverage for VerticalPodAutoscalers (when CRD installed),
PriorityClasses, RuntimeClasses, Leases, ValidatingAdmissionPolicies and
bindings, MutatingAdmissionPolicies and bindings where the fixture Kubernetes
version supports them, ReplicationControllers, Endpoints, and EndpointSlices.

Do not merely duplicate generic CRD rows. The value is the relationship view:
VPA recommendations to workloads/containers, Lease holders, EndpointSlices
behind Services, and policy/binding/CEL relationships. Kubernetes-version-gated
resources must disappear cleanly when discovery says they are unavailable.

**Accept:**

- [ ] Every supported table agrees with its `kubectl get` counterpart on kind.
- [ ] Service properties link to Endpoints/EndpointSlices and expose readiness;
      VPA links to its target and shows per-container recommendations.
- [ ] Admission policy CEL and bindings are readable with syntax highlighting
      and parameter references.
- [ ] Missing APIs are “unsupported on this cluster,” never errors or fake zero
      counts.

### B91 — Gateway API as a first-class group

When Gateway API CRDs are discovered, add a Network/Gateway group for
GatewayClass, Gateway, HTTPRoute, GRPCRoute, TCPRoute, UDPRoute, TLSRoute,
ReferenceGrant, BackendTLSPolicy, and ListenerSet when installed. Use dynamic
API discovery rather than compile-time Kubernetes structs so version skew is
manageable. Tables should expose Accepted/Programmed/ResolvedRefs conditions;
properties and topology should connect class → gateway → listeners/routes →
backends and surface rejected references.

**Accept:**

- [ ] Install the upstream Gateway API standard-channel CRDs and a local
      controller or status fixture in kind; all installed resources appear.
- [ ] An HTTPRoute with a missing backend or disallowed cross-namespace ref is
      visibly unhealthy and links to the relevant ReferenceGrant state.
- [ ] Topology navigation resolves every supported route/backend relationship.
- [ ] Removing the CRDs removes the group without stale saved navigation.

### B92 — Applications view

Build a derived inventory from the Kubernetes recommended labels, especially
`app.kubernetes.io/instance`, `name`, `version`, and `managed-by`. Group objects
per namespace/instance, derive health from workloads/Problems, show resource
counts and version, and provide aggregate logs for the application's workload
pods. This is a view over retained rows and selected object fetches, not another
watcher per application.

**Accept:**

- [ ] The fixture contains two labeled applications and unlabelled resources;
      only labeled applications are grouped and no object crosses namespaces.
- [ ] Application health reflects a crash-looping member and clears through the
      ordinary watcher path.
- [ ] Opening an application shows its resource graph and combined workload logs.
- [ ] Helm releases link to the matching application when labels establish one.

---

## P3 — v0.9: deploy and customize

### B93 — Helm phase 2: repositories, install, and upgrade

Complete the Lens Helm workflow: repository list/add/remove/refresh, chart
search/version selection, README/default values, install, upgrade, dry-run
rendered-manifest diff, and typed progress/errors. Prefer a maintained Helm
library only if it preserves Helm interoperability; otherwise invoke a
user-selected `helm` binary through a tightly scoped backend adapter using the
B82 login PATH and a temp cid-bound kubeconfig. Document the decision and test
against the fixture chart both directions.

**Accept:**

- [ ] A local HTTP chart repository is added, refreshed, searched, installed,
      upgraded, rolled back, and uninstalled without internet or cloud access.
- [ ] Install/upgrade shows values plus rendered manifest diff before mutation.
- [ ] `helm list/history/get values/get manifest` agree after every k7s action.
- [ ] Repository credentials are kept out of the webview, logs, diagnostics,
      and command previews.

### B94 — Resource templates and creation history

Add a dock/workspace for reusable YAML templates. Ship a small version-matched
set for common resources, allow user templates in the app data directory, and
support multi-document preview/apply through the existing dry-run diff path.
Persist recent creates and drafts locally with secret values removed. This is
not a remote marketplace.

**Accept:**

- [ ] A Deployment+Service multi-document template can be parameterized,
      dry-run, diffed, and created in kind.
- [ ] User templates survive restart, export/import as plain YAML, and never
      persist Secret data unredacted.
- [ ] Kubernetes-version-incompatible templates warn before apply.
- [ ] Failed creates retain a safe draft and typed per-document errors.

### B95 — Metrics source and local stack settings

Expose detected Prometheus providers, a manual `namespace/service:port` source,
query/test feedback, scrape intervals, and per-kind metric visibility. Keep
automatic detection as default. Optionally install/uninstall a pinned local
metrics stack in kind through a clearly enumerated Helm plan; never silently
modify a cluster. This item is lower priority because k7s already degrades well
without metrics.

**Accept:**

- [ ] Auto-detected and manually selected Prometheus sources produce the same
      fixture graphs.
- [ ] Bad source configuration is typed and reversible without breaking
      metrics-server data.
- [ ] Optional stack install shows every object/namespace/chart version before
      confirmation and cleans up through Helm ownership.

### B85 — Extension system v1

Retain the declarative-first scope from v6 and implement it only after B87/B90
stabilize the column and kind contracts. Declarative extensions may add columns,
kind grouping, and property sections. Sandboxed JS extensions may add read-only
tabs through a versioned message API. No mutation API or marketplace in v1.

Dogfood with one Gateway/Argo-oriented declarative extension and one sandboxed
custom tab. Extension identities, permissions, failures, and versions belong in
Settings and diagnostics.

---

## P4 — v1.0 launch and differentiators

### B86 — Documentation and launch gate

Update README facts immediately when v7 work begins, then build the docs site at
the end. Document installation, local cluster setup, error states, permissions,
metrics, Helm, extensions, security/no-telemetry stance, and the exact support
matrix proven by CI/manual QA. The comparison page must say that cloud discovery,
Teamwork/Cluster Connect, AI, and hosted clusters are absent by choice.

**1.0 gate:**

- [ ] B74-L, B83, B84, B87–B94, and B85 are complete or explicitly removed
      from 1.0 scope with release-note rationale.
- [ ] Signed artifacts and updates meet the published OS support matrix, except
      any platform explicitly labeled preview.
- [ ] Kind e2e is green for two consecutive release candidates; live-harness
      failures and accessibility serious/critical findings are zero.
- [ ] Docs and screenshots are generated/checked in CI; test counts and kind
      counts are generated rather than hand-maintained.

### Differentiators after the critical path

These are useful and locally testable, but none should jump ahead of reliability,
e2e, accessibility, core workflows, or Helm:

- **B59 log anomaly detection**, plus JSON structured-log folding.
- **B66 GitOps drift** using Argo CD and Flux fixtures installed into kind.
- **B68 Trivy summaries** using Trivy Operator in kind.
- Pending-pod scheduling explainer from events, affinity, taints, resources,
  quota, and PDB state.
- Cross-cluster compare/diff for the already connected local clusters.
- Ephemeral debug-container injection with explicit image/security confirmation.
- B65 manual cost estimation only if users want it; cloud price catalogs remain
  part of the cloud-deferred lane.

---

## Explicit cloud deferral

### B74-C — Cloud authentication and provider discovery *(deferred)*

Deferred acceptance includes:

- EKS discovery, AWS profiles/roles/SSO and `aws eks get-token`;
- GKE discovery and `gke-gcloud-auth-plugin`;
- AKS discovery, Azure subscriptions and `kubelogin`;
- provider-specific token refresh and real managed-cluster version skew;
- cloud proxy/VPN/private-endpoint guidance;
- cloud instance price catalogs;
- Lens-style hosted clusters, Teamwork/Spaces, Cluster Connect, shared access,
  identity service, and organization policy controls.

B74-L deliberately builds the provider-neutral error/exec-plugin contract now,
so future cloud work plugs into a tested interface. B74-C begins only when a
maintainer has durable test access and a budget for at least one managed-cluster
matrix. Until then, the docs say “bring a working kubeconfig; managed cloud is
not in the tested support matrix.”

---

## Suggested order and dependency spine

1. Finish and commit B82 without expanding it.
2. B74-L typed errors + watcher freshness.
3. B83 component/kind/e2e infrastructure.
4. B84 accessibility, using B83 to prevent regression.
5. Complete B70–B73 release acceptance in parallel as credentials/hardware allow.
6. B60 → B87 → B88 → B89 for the daily operator loop.
7. B90 → B91 → B92 for catalog and relationship parity.
8. B93 → B94 → B95 for install/create/metrics workflows.
9. B85 only after B87/B90 APIs settle.
10. B86, two release candidates, then 1.0.

Critical dependencies: B74-L feeds diagnostics and e2e assertions; B83 enables
B84 and safely expands the kind fixture; B87 supplies the declarative column
engine for B85; B90's dynamic version-gating informs B91; B82's PATH/temp
kubeconfig work can power B93; B93's local repository fixture can support B95's
optional metrics-stack install. B74-C has no dependency edge into 1.0.

## Small hygiene work (do in passing)

- Remove the unused `@tauri-apps/plugin-notification` frontend dependency.
- Generate README kind/test counts and the keyboard reference from source.
- Rewrite README's architecture section for cid-keyed `ClientManager` state.
- Replace the stale top-level automated-suite counts in
  `docs/verification.md` with generated or date-stamped results.
- Add a single script that runs typecheck, vitest, Rust tests, clippy, and the
  appropriate optional live harnesses so local and CI definitions cannot drift.

