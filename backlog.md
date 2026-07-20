# k7s — Backlog (v4)

Open work first, shipped work at the bottom. Detailed per-item records —
verification notes, design decisions, corrections — live in the git log; the
completed section here is an index, not the archive.

Conventions (see [tasks.md](tasks.md)): each open item is self-contained with
**Do**/**Accept**; the DoD is clippy `-D warnings` + `cargo test` + `tsc` +
`vitest` + live or demo verification; colors come from tokens only. Backend
patterns: commands for one-shots, events for streams, abortable tasks
registered in [ClientManager](src-tauri/src/kube/manager.rs); lazy per-object
work follows the CRD-watcher / node-scraper shape (start on open, stop on
leave, counted in watch-status). References to other objects are links, and a
reference that doesn't resolve says so (`ref_cell`) rather than linking to a
404.

### What the test cluster can and can't verify (updated 2026-07-19)

- **Only `freya` is Ready.** `leo` and `mars` are NotReady (offline since
  2026-07-03 / 2026-07-14), so anything per-node is verifiable on one node.
- **metrics-server is broken (503)** — `metrics.k8s.io` items degrade to demo
  verification, honestly noted.
- **Prometheus works now.** The scrape config was converted to `role: node`
  service discovery (2026-07-18) after its static targets pointed at a
  decommissioned IP; `node_*` and cadvisor series are landing. Retention is
  24h, so history is shallow.
- Deployments are mostly single-replica; multi-pod acceptance uses the app's
  own Scale action to make a second pod, then scales back.
- Standing defects that make *great* test fixtures: `wiki/wiki-…-djpwx` in
  CrashLoopBackOff (3300+ restarts), a pod stuck Terminating, `wiki-postgres`
  Pending, recurring FailedMount warnings in `cb8`. Chatty log fixture:
  `argocd/argocd-application-controller-0` (13k+ lines).

---

## P0 — highest priority

### B30 — CRD printer columns
*Why: custom kinds show NAME / NAMESPACE / AGE, which wastes the whole point
of B15 on CRDs like Argo's. The CRD declares its own columns
(`additionalPrinterColumns` with JSONPath) and we already fetch the full CRD
at discovery and throw that part away. Verified on freya: the Application CRD
declares Sync Status and Health Status, live apps read Synced/Progressing and
Synced/Healthy.*

**Do:** Extend [discovery.rs](src-tauri/src/kube/discovery.rs) to carry each
kind's printer columns (name, type, jsonPath; skip `priority > 0` — kubectl
hides those without `-o wide` too). Implement a deliberately small JSONPath
subset in a new `jsonpath.rs`: dotted field access plus `[n]` array index over
`serde_json::Value` — that covers every column freya's 44 CRDs declare;
anything it can't evaluate renders "—" rather than guessing. `map_dynamic`
appends evaluated columns between NAMESPACE and AGE; `date`-typed columns
render through the age cell; tone stays secondary (v1 takes no colour opinions
on arbitrary CRDs). Frontend: `kindMeta` for a custom kind builds its columns
from the discovered metadata.

**Accept:**
- [ ] Argo Applications on freya show SYNC STATUS and HEALTH STATUS live,
      matching `kubectl get applications -n argocd` exactly.
- [ ] Kinds with no printer columns keep the generic set; an unevaluable
      jsonPath shows "—" and logs once.
- [ ] The JSONPath subset is unit-tested against the exact expressions on
      freya's CRDs, plus array-index and missing-field cases.

### B31 — Workload logs (stern-style)
*Why: "why is this Deployment misbehaving" means reading all its pods' logs
interleaved, not opening pods one at a time. B7 already interleaves containers
within a pod; this is the same idea one level up.*

**Do:** Backend: `start_workload_logs(kind, ns, name)` resolves the workload's
selector, starts one log pump per matching pod, and multiplexes into a single
stream id; lines carry a `pod` field the way B7 lines carry `container`. Pod
set re-resolves on a slow tick (~15s) so scale-ups join and gone pods drop;
the bundle registers as *one* manager entry (one watch-count unit, one abort).
Frontend: Deployments/STS/DS gain the Logs tab; the line prefix shows a short
pod suffix tinted with the per-source palette.

**Accept:**
- [ ] Scale a freya Deployment to 2 via the app's own Scale action: both pods'
      lines interleave with distinct prefixes; scale back and the second
      prefix stops within a tick.
- [ ] Search/timestamps/follow/save (B29) work unchanged on workload streams.
- [ ] Closing the tab tears down every per-pod pump (watch-status returns to
      baseline — the same proof B15 uses).

### B44 — Pod CPU/MEM sparklines from Prometheus
*Why: the deferred half of B38. The cadvisor series are landing (145 of them
on freya) since the scrape fix — the data exists; this is a UI surface, not
plumbing.*

**Do:** Reuse `promql.rs`: `pod_history(ns, pod)` over
`container_cpu_usage_seconds_total` / `container_memory_working_set_bytes`
summed per pod (cadvisor's `node` label keys the join). Render small
sparklines in the pod detail header (or a Metrics section of Properties) —
not per-row in the table, which would fire hundreds of range queries. Same
degrade rule as B38: no Prometheus → no sparklines, nothing surfaced as an
error.

**Accept:**
- [ ] A freya pod shows CPU/MEM sparklines with plausible values (cross-check
      one against `kubectl top pod` when metrics-server is fixed, else against
      Prometheus directly).
- [ ] A cluster without Prometheus renders the panel exactly as today.
- [ ] Opening a pod fires a bounded number of queries (≤2 range queries), and
      closing cancels any in flight.

## P1 — next

### B32 — Problems view
*Why: the data to answer "is anything wrong?" is already streaming into the
store — it's just scattered across six kinds. freya demonstrates today: two
NotReady nodes, a CrashLoopBackOff, a stuck Terminating, a long Pending,
recurring FailedMount warnings.*

**Do:** A `problems` pseudo-kind at the top of the Cluster group
(frontend-only aggregation, like the namespace pod counts — no new watchers).
Sources, each with a one-line reason: NotReady/unschedulable nodes; pods with
err tone, Pending or Terminating beyond a threshold; degraded workloads
(ready < desired); failed Jobs; Warning events. Columns: SEVERITY, KIND,
OBJECT, REASON, AGE — red before amber, then newest. Rows navigate to the
object (the B28/B33 jump). Sidebar count badge toned by worst severity; zero
problems renders a deliberately quiet "nothing wrong" state.

**Accept:**
- [ ] freya today lists: leo + mars NotReady, the wiki crash-looper, the stuck
      Terminating pod, the Pending postgres, cb8's FailedMount warnings — each
      with a legible reason, worst first.
- [ ] Clicking a problem lands on the object with the detail panel open.
- [ ] The derivation is a pure function over store rows with vitest cases per
      source (including "healthy cluster → empty").

### B34b — Rollout undo
*Why: restart shipped (B34); its safety net didn't. The Deployment properties
panel already shows the ReplicaSet revision history this needs.*

**Do:** `undo_rollout(ns, name, revision)` copies the target ReplicaSet's pod
template back onto the Deployment (revisions from the same owner-uid +
revision-annotation logic properties.rs already has). Frontend: "Roll back to
revision N…" per-row in the properties ReplicaSets table for non-current
revisions, with a red confirm naming the revision.

**Accept:**
- [ ] Unit test pins the template-copy (fixture Deployment + two RS revisions
      → patch equals the old template).
- [ ] Live, against a scratch Deployment (B36's create, or kubectl-made):
      restart cycles a new RS revision; undo returns to the prior template.
- [ ] Rows for the *current* revision don't offer the action.

### B45 — Discovery-based live harnesses
*Why: six of the `examples/*_check.rs` harnesses hardcode freya's namespaces
and pod names; the four written later (`storage_check`,
`related_links_check`, `helm_props_check`, `promql_check`) discover their own
fixtures and run anywhere. Now that the repo is public, the harnesses are the
project's proof-of-honesty — they should run on any cluster, including a
fresh kind cluster.*

**Do:** Convert `live_check`, `crd_check`, `properties_check`, `logs_check`,
`helm_check`, `svc_forward_check` to discover fixtures (highest-restart pod
for crash-loop cases, any pod with volumes, any Helm release, etc.), degrading
to a skip-with-message when a cluster has no suitable fixture rather than
failing. Document the pattern in the README's verification section.

**Accept:**
- [ ] Every harness runs green against freya with no edits.
- [ ] Every harness runs against the kind fixture cluster (`dev/cluster/up.sh`)
      and either passes or prints an explicit "no fixture for X, skipping".
- [ ] No harness names a namespace or pod that isn't discovered at runtime.

### B46 — The remaining reference gaps
*Why: the audit trail from B40–B43. What's left is small and enumerable, and
each is the same defect the PV column was: the app knows a relationship and
doesn't show or link it.*

**Do:** Three ungathered references: **imagePullSecrets** and **env/envFrom**
ConfigMap/Secret refs on the pod panel (existence-checked via `ref_cell`,
like volume sources); **Helm release → installed objects** — the manifest is
already decoded, so parse kind/name pairs out of it and render an "Objects"
table on the release panel, linking the kinds we list. Plus properties
gatherers for the storage kinds: a **PVC panel** showing which pods mount it
(reverse of the pod's Storage table), its volume, class and events; a **PV
panel** showing its claim and reclaim state; **ReplicaSet panel** showing its
pods and owner Deployment.

**Accept:**
- [ ] A pod using a private registry shows its pull secret as a link; an env
      var sourced from a ConfigMap links to it.
- [ ] freya's `traefik` release lists the objects it installed, each a link
      when the kind is listed.
- [ ] A PVC panel answers "who mounts this" — verified against
      `wiki-postgres-data` → the postgres pod.
- [ ] `related_links_check` extended to walk the new panels; all links resolve.

## P2 — later

### B36 — Create from YAML  *(the dry-run diff half shipped — see below)*
**Do:** A "+ Create" affordance (topbar or ⌘K action): paste/edit a manifest
in the CodeMirror editor, `create` it via the dynamic API (kind/ns parsed from
the manifest). **Accept:** creating a scratch ConfigMap and a Deployment works,
which also gives B34b its live fixture; the dry-run preview shipped below
applies to the create path too.

### B37 — Secret values: copy without display
**Do:** The app's stance is that Secret values never render — but *using* a
secret is legitimate. Per key in a Secret's detail: a "copy value" button
whose command decodes and writes the value to the clipboard **in Rust**
(`tauri-plugin-clipboard-manager`), so the plaintext never enters the
webview/DOM; UI shows only a "copied ✓" flash. **Accept:** pasted value
matches `kubectl get secret … | base64 -d`; the value never appears in Tauri
event traffic; YAML/table remain redacted.

### B47 — CronJob and Job verbs
*Why: the workload verbs shipped (scale, restart, drain) skip the batch kinds
entirely, and both of their missing verbs are things kubectl makes annoyingly
manual.*

**Do:** **Suspend/resume** a CronJob (patch `spec.suspend`, status shown in
the table with a muted "suspended" tone); **Run now** (create a Job from the
CronJob's jobTemplate with a `manual-` name prefix, the exact mechanic of
`kubectl create job --from=cronjob/x`); **Retry** a failed Job (delete +
recreate from its own spec, minus controller-owned fields). All through the
actions menu with the usual confirm. **Accept:** suspending freya's cronjobs
stops schedule-time Jobs appearing; Run now produces a Job that runs to
completion and is visibly owned by nothing (so it's deletable); unit tests pin
the jobTemplate copy (immutable fields stripped).

### B48 — TLS certificate inspection
*Why: `kubernetes.io/tls` Secrets hold certs whose expiry is the thing that
takes sites down, and the app deliberately never shows secret values — but a
cert's metadata (subject, SANs, issuer, notAfter) isn't secret.*

**Do:** For `kubernetes.io/tls` Secrets, a Properties section parsing the
public cert **in Rust** (the private key is never touched): subject, SANs,
issuer, valid-from/notAfter — notAfter toned amber under 30 days, red when
expired. The Ingress TLS table inherits the tone on its SECRET link, so an
expiring cert is visible from the routing side. **Accept:** a live TLS secret
shows correct fields vs `openssl x509 -text`; an expired fixture cert reads
red; the private key never appears in any payload (grep the event traffic, the
B37 proof).

### B49 — RBAC: who can do what
*Why: 16 Roles / 83 ClusterRoles / 86 bindings on freya and the app shows none
of it. The interesting question isn't listing them — it's the chain: this
ServiceAccount → these bindings → these rules.*

**Do:** Tables for Roles/ClusterRoles/RoleBindings/ClusterRoleBindings (an
Access nav group; move ServiceAccounts there). The ServiceAccount panel gains
the resolved chain: bindings naming it, each linking to its role, with the
role's rules rendered as a compact verb×resource table. **Accept:** freya's
`prometheus` SA shows the `panoptes-prometheus` binding → ClusterRole with
`nodes/metrics` + `nodes/proxy` — the exact chain debugged by hand during the
Prometheus fix; binding subjects that reference absent SAs render with the
`ref_cell` not-found treatment.

### B50 — Warning notifications
*Why: the app knows about CrashLoopBackOff the moment it happens; the person
running it finds out when they next look. Desktop notifications are the point
of being a native app.*

**Do:** Opt-in (Settings, default off): native notifications via
`tauri-plugin-notification` for *transitions into* a problem state (B32's
derivation reused — new Warning event burst, pod entering err tone, node going
NotReady). Debounced per object (one notification per object per cooldown,
not per event), never while the window is focused. Clicking the notification
focuses the window and jumps to the object. **Accept:** killing a pod's
process on freya notifies once within a poll tick; a crash-looper doesn't
re-notify every restart within the cooldown; focused-window activity produces
nothing.

### B51 — Publishing hygiene
**Do:** Pick and add a LICENSE (the repo is public and currently
all-rights-reserved by default); a README screenshot from demo mode; CI
(GitHub Actions: clippy + cargo test + tsc + vitest on push — the B25 release
pipeline exists but nothing runs the test gate on the public repo).
**Accept:** fresh clone shows license + screenshot on the landing page; a PR
that fails clippy is red.

## Parking lot (one-liners, not yet worth a number)

- **App auto-update** — tauri-updater riding the B25 release pipeline; wants a
  signing identity first.
- **RBAC-aware actions** — `SelfSubjectAccessReview` to grey out verbs the
  user can't perform instead of failing on click (pairs with B49).
- **Watch staleness badge** — a watcher stuck in backoff currently degrades
  silently; surface per-kind staleness in the table header.
- **Copy as kubectl** — per-row "copy kubectl command" for handing to people
  without k7s.
- **Multi-cluster windows** — one connection per window via Tauri
  multi-window; the ClientManager-per-window boundary already almost allows it.
- **NetworkPolicies** — 7 on freya; a table is easy, but the *useful* version
  (which policies select this pod, in the pod panel) is a selector-matching
  join worth designing properly.
- **Persistent port-forwards** — forwards die with the app; remember and
  re-establish them on reconnect (prefs already persist imports).

## Suggested order

B30 → B31 → B44 (P0) → B32 → B34b → B45 → B46 (P1) → B36 → B37 → B47 →
B48 → B49 → B50 → B51.
Dependencies: B34b's live fixture wants B36's create (or a kubectl-made
scratch Deployment); B44 and B50 reuse B32's problem derivation and B38's
promql plumbing respectively; B49 is where ServiceAccounts move out of Config.

---

## Completed

Newest first. One line each — the full records (design decisions, live
verification, corrections of wrong premises) are in the git log and, for
B28–B43, in the commit messages of `feat/backlog-qol`.

### Backlog v4 (B39, B52–B53)

- **B39 — Bulk selection & row context menu.** Shift/⌘-click multi-select and a
  right-click menu. The substance is the shared action model (`lib/actions.ts`):
  actions as data, so the detail panel and the row menu can't disagree about what
  a kind allows. Each action declares `bulk` — scale and forward need a parameter,
  drain streams per-node progress, so none of them appear for a selection.
  Confirmations enumerate names, not just counts. Bulk runs use `allSettled` and
  report partial failure per object. Selection is keyed by uid (rows are replaced
  wholesale on every watch update) and pruned against the visible list.
  *Two bugs found by driving the real UI: a stale-closure read made shift-click
  extend from the wrong anchor, and a capture-phase scroll listener let the
  auto-scrolling log pane close the menu instantly.*

- **B53 — Node debug shell.** Privileged pod pinned with `nodeName` (bypasses the
  scheduler, so cordoned/tainted nodes work), `nsenter` into PID 1's namespaces
  for a real host shell. Safety design is the substance: `activeDeadlineSeconds`
  as a server-side backstop that outlives an app crash, an orphan sweep by label
  on every start, delete-on-close outside the aborted task, and an explicit
  consent gate so tabbing past a node can't provision anything. Image is
  configurable (multi-arch matters on mixed-arch clusters).
  *`examples/nodeshell_check.rs` verifies admission by dry run; `--for-real` runs
  the full create/nsenter/delete cycle.*

- **B52 — Light theme.** Second palette in tokens.css under `[data-theme=light]`,
  with tests that read the stylesheet and assert the two palettes define the same
  token set — the failure mode is a *missing* declaration, which silently keeps
  the dark value. xterm and plotly can't read CSS variables, so they resolve
  tokens at runtime through `lib/theme.ts`. Applied via a store subscription
  rather than an effect, because React runs child effects before parent ones and
  the canvas widgets would otherwise read the previous palette.

### Backlog v3 (B28–B43)

- **B36a — Dry-run diff before apply.** Editing YAML in place existed since E5
  but applied blind. Apply is now two steps: `dryRun=All` through the whole
  admission chain, then a diff of the live object against the object that
  *would* be stored, so defaulting and mutating webhooks are visible before
  anything is written. LCS line diff with context hunks (`lib/diff.ts`, 13
  tests); read-only guards factored to `ensure_writable` so the preview and the
  real apply can't disagree about Helm/Secrets. Live: dry run echoes the
  proposed annotation, the live object is untouched, and a stale
  resourceVersion is rejected at preview time rather than at apply.
- **B43 — Ingress detail + IngressClasses.** Rules/TLS tables with
  existence-checked backend links; named backend ports handled; `ref_cell`
  born here.
- **B42 — Links B41 missed + ServiceAccounts.** Endpoints/STS-storage tables
  wired; SA kind added (SECRETS column flags hand-attached tokens); caught a
  second 404 (STS `serviceName` naming a Service Argo never created).
- **B41 — Cell-level nav, ReplicaSets, StorageClasses, volume sources.**
  `NavTarget` on `Cell`; two new kinds; ConfigMap/Secret volume names
  surfaced; live harness caught a link to an optional-and-absent Secret —
  sources are existence-checked via `get_metadata`.
- **B40 — PersistentVolumes & PersistentVolumeClaims.** Storage nav group;
  Pending claims show requested capacity; PVs get their own tone function
  (Available ≠ error).
- **B38 — Prometheus-backed node-chart history.** `promql.rs`: discovery by
  convention, `query_range` via the service proxy, timestamp-joined series,
  live-wins merge; unblocked by converting freya's scrape config to `role:
  node` SD. *Pod sparklines deferred → B44.*
- **B37/B36 — not done** (moved above). *B39 shipped — see Backlog v4.*
- **B35 — Helm release detail.** Overview / full revision history / values
  flattened with credential keys redacted in Rust.
- **B34 — Restart** (pod delete-and-recreate with bare-pod refusal; workload
  rollout-restart via `restartedAt` patch, validated server-side by dry run).
  *Undo half → B34b.*
- **B33 — Related-resource navigation.** Owner links resolving through
  ReplicaSets; workload → pods via label-selector filter syntax
  (`lib/filter.ts`); clickable events via Kind+group → nav id resolution.
- **B32/B31/B30 — not done** (moved above).
- **B29 — Crash-loop debugging.** `previous` reads (terminate, never follow),
  since-windows, save-to-file written in Rust (13k lines / 4.8MB past the
  200-line ring buffer). Backlog premise about `previous` corrected in the
  process.
- **B28 — Command palette (⌘K).** fzy-style scorer (`lib/fuzzy.ts`), kinds /
  objects / actions ranked in one list, `ns:` scoping, atomic `jumpTo`.
- **B27 — Node metrics plots.** node-exporter scraped over a port-forward,
  lazy per-open-tab; plotly charts; counter-rate sampler with virtual-iface
  and pseudo-fs filtering.

### Backlog v2 (B14–B26) — all shipped

Cluster-wide Events view (B14) · CRD discovery + lazy watchers (B15) ·
Service port-forwards with targetPort resolution (B16) · persisted kubeconfig
imports (B17) · Properties beyond pods (B18) · shell UX polish (B19) · drain
via the eviction subresource, PDB-aware (B20) · table virtualization (B21) ·
window-state persistence incl. SIGTERM (B22) · settings panel with poll
intervals and log-buffer cap (B23) · dev launch hygiene, `dev/run.sh` (B24) ·
release pipeline: .app/.dmg + CI caveats (B25) · Helm releases decoded from
storage Secrets, manifest redaction, `latest_only` (B26).

### Backlog v1 (B1–B13) — all shipped

Detail panel for all kinds (B1) · table filter (B2) · resource actions:
delete/scale/cordon (B3) · exec shell over xterm (B4) · column sorting (B5) ·
pod port-forwards (B6) · multi-container interleaved logs (B7) · keyboard
navigation (B10) · persisted UI state (B11) · namespace pod counts (B12) ·
pod properties panel (B13).

### Epics (E1–E8) — the original build, all shipped

Scaffold & design foundation (E1) · Rust Kubernetes core: client manager,
watchers → Row DTOs, metrics/status pollers (E2) · app shell: sidebar,
topbar, status bar (E3) · resource tables for the 12 original kinds (E4) ·
pod detail panel: logs/YAML/events (E5) · context switching & resilience
(E6) · verification, pixel fidelity, packaging (E7) · kubeconfig import (E8).
Story-level breakdown: [tasks.md](tasks.md).
