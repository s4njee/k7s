# k7s — Backlog (v3)

New work only. Everything before this — the original epics (E1–E8) and both
earlier backlogs (B1–B26 plus B27, the node-exporter plots) — is **shipped** on
`feat/backlog-qol`; the per-item records, verification notes and design
decisions live in the git log rather than being repeated here. Numbering
continues from B27.

Conventions are unchanged (see [tasks.md](tasks.md)): each item is
self-contained with **Do**/**Accept**, the DoD is clippy `-D warnings` +
`cargo test` + `tsc` + `vitest` + live or demo verification, colors come from
tokens only. Backend patterns: commands for one-shots, events for streams,
abortable tasks registered in
[ClientManager](src-tauri/src/kube/manager.rs); lazy per-object work follows
the CRD-watcher / node-scraper shape (start on open, stop on leave, counted in
watch-status).

### What the test cluster can and can't verify

Acceptance criteria below are written against freya's *actual* state
(2026-07-17), which constrains what "verified live" can honestly mean:

- **Only `freya` is Ready.** `leo` and `mars` are NotReady, so anything
  per-node is verifiable on exactly one node.
- **metrics-server is broken (503)** — `metrics.k8s.io` items degrade to demo
  verification, honestly noted.
- **Prometheus has no node data** (scrape targets point at a decommissioned
  node IP). B38 stays gated on that cluster-side fix.
- Deployments are mostly single-replica; multi-pod acceptance uses the app's
  own Scale action to make a second pod, then scales back.
- Standing defects that make *great* test fixtures: `wiki/wiki-6b6d775f4-djpwx`
  in CrashLoopBackOff (3258 restarts), `wiki/wiki-6b6d775f4-h97vb` stuck
  Terminating for 16 days, `wiki-postgres` Pending for 13 days, recurring
  FailedMount warnings in `cb8`.

---

## P0 — highest priority

### B28 — Command palette (⌘K)
*Why first: every view in the app is now reachable, but only by mouse-walking
the sidebar. One fuzzy box that jumps to any kind, any object, or any action is
the single biggest daily-use upgrade left — it's the feature people actually
touch a hundred times a day in Lens/k9s.*

**Do:** ⌘K (and `:` like k9s) opens a centered palette over the app. Three
result classes, ranked in one list: **kinds** ("pods", "Releases", discovered
CRD kinds by Kind name), **objects** (fuzzy over `name` and `namespace/name`
across all rows already in the store — no new backend), and **actions** for the
current selection ("Restart rollout…", "Cordon", "Forward…"). Enter navigates /
selects / runs; typing `ns:prod ` as a prefix scopes the namespace filter.
Fuzzy match is subsequence-based with contiguous-run and word-boundary bonuses
(pure function in `src/lib/fuzzy.ts`, unit-tested). Selecting an object sets
nav + namespace + selects the row (reuse `selectRow`); the row must end up
visible in the virtualized table (B21's `scrollToShow`).

**Accept:** *(shipped — needs a GUI pass to confirm it feels right)*
- [x] `wik` ranks the crash-looper first; `releases` reaches the Helm view;
      `applications` reaches the Argo CRD kind (by its id — the plural doesn't
      match the Kind label "Application"). Pinned by vitest against
      freya-shaped data.
- [x] Objects of unwatched CRD kinds are absent (their rows aren't loaded); the
      kind itself still matches, and jumping to it starts its watcher.
- [x] Esc closes only the palette, leaving the filter and detail panel behind it
      alone — tested by dispatching real key events at the document listener.
- [x] Ranking, `ns:` parsing, and `jumpTo`'s namespace behaviour are unit-tested
      (54 new cases).
- [ ] **Not verified:** how it looks and feels — highlight legibility, focus,
      the jumped-to row being visible in a long list.

*Two deviations from the sketch above, both deliberate. **j/k don't move the
cursor**: in the palette you're typing a name, and names contain j and k — arrows
and ⌃n/⌃p idioms are free, letters aren't. And the **object actions are only
cordon/uncordon**: delete, drain, scale and forward each need a confirmation or
a parameter, and that UI lives in the detail panel's actions menu — a palette
where Enter can delete a pod is a footgun, not a shortcut. B34's rollout restart
will want the same treatment (a confirm), so it belongs there too.*

*Also fixed in passing: the `[`/`]` tab-cycle keys had drifted from the tab strip
— they still believed non-pods had only YAML+Events, which stopped being true at
B18 (Properties beyond pods), B26 (Helm has no Events) and B27 (Metrics), so
cycling landed on tabs that weren't rendered. Both now read one `tabsFor()`.*

### B29 — Crash-loop debugging: previous logs, since, save-to-file
*Why: the single most common debugging motion the app can't do today. The
current container of a crash-looper has seconds of logs; the answer is always
in the **previous** container's output. freya has a live specimen with 3258
restarts to prove it on.*

> **Correction (found while building this).** The "always" above is wrong. While
> a container sits in CrashLoopBackOff it *isn't running*, so the API already
> serves the last terminated container for a plain read — `current` and
> `previous` return identical bytes, which is exactly what freya's wiki pod shows.
> They diverge only once the container has restarted and is running again: then
> the live stream shows the new attempt's first seconds and `previous` is the only
> way to see why the last one died. Still worth having — that's the moment you're
> usually looking — but the justification was overstated.

**Do:** Backend: `LogParams.previous` and `since_seconds` threaded through
`start_log_stream` (kube supports both natively). Frontend, in the logs
toolbar: a "previous" toggle (shown only when `restarts > 0`), a since selector
(`5m / 1h / 24h / all` — maps to `since_seconds`, replacing the stream on
change like the container cycler does), and a save button that writes the
*full* current stream to a file via the existing dialog plugin (`.save()`), not
just the ring buffer — the backend re-fetches without `tail` for the export so
the file isn't capped at the on-screen 200 lines.

**Accept:** *(shipped — needs a GUI pass)*
- [x] `previous` reads the prior container generation and **terminates** rather
      than hanging on a dead container — verified against the wiki crash-looper
      with `cargo run --example logs_check`: returns in 6ms. (See the correction
      above for what this fixture can and can't demonstrate.)
- [x] Toggling previous/since empties the buffer rather than mixing generations;
      "previous" isn't offered on a 0-restart pod (`hasPrevious`), and the follow
      control is hidden for a previous read — there is nothing to follow.
- [x] The export reaches past the ring buffer: `argocd-application-controller-0`
      saves **13,553 lines / 4.8MB** where the view holds 200. A since window
      still bounds it (5m → 22 lines).
- [ ] **Not verified:** the toolbar itself — the controls, the save dialog, and
      the footer's "↺ previous container" state.

*The API constrains two things, both now pinned by tests: `previous` can't be
followed (a dead container never emits again, so following it hangs the task
instead of ending the stream), and `since_time` and `since_seconds` are mutually
exclusive (sending both is a 400) — the resume anchor wins, since it's more
precise and always inside the window anyway.*

*The backend writes the export file itself rather than returning the text: 4.8MB
has no business crossing the IPC bridge and landing in the webview's heap just to
be written straight back out.*

### B30 — CRD printer columns
*Why: custom kinds currently show NAME / NAMESPACE / AGE, which wastes the
whole point of B15 on CRDs like Argo's. The CRD itself declares its columns —
`additionalPrinterColumns` with JSONPath — and we already fetch the full CRD at
discovery and throw that part away. Verified on freya: the Application CRD
declares Sync Status (`.status.sync.status`) and Health Status
(`.status.health.status`), and the live apps read Synced/Progressing and
Synced/Healthy.*

**Do:** Extend [discovery.rs](src-tauri/src/kube/discovery.rs) to carry each
kind's printer columns (name, type, jsonPath; skip `priority > 0` columns —
kubectl hides those without `-o wide` too). Implement a deliberately small
JSONPath subset in a new `jsonpath.rs`: dotted field access plus `[n]` array
index over `serde_json::Value` — that covers every column freya's 44 CRDs
declare; anything it can't evaluate renders "—" rather than guessing.
`map_dynamic` appends the evaluated columns between NAMESPACE and AGE; columns
of type `date` render through the existing age cell; tone stays `secondary`
(the backend can't know which values are "bad" for an arbitrary CRD — v1 takes
no colour opinions). Frontend: `kindMeta` for a custom kind builds its column
list from the discovered metadata instead of the fixed generic set.

**Accept:**
- [ ] Argo Applications on freya show SYNC STATUS and HEALTH STATUS live —
      `cb8` reads Synced/Progressing, `csearch-v2` Synced/Healthy — matching
      `kubectl get applications -n argocd` exactly.
- [ ] Kinds with no printer columns keep the generic set; a jsonPath the subset
      can't evaluate shows "—" and logs once (no crash, no wrong value).
- [ ] The JSONPath subset is unit-tested against the exact expressions found on
      freya's CRDs, plus array-index and missing-field cases.

### B31 — Workload logs (stern-style)
*Why: "why is this Deployment misbehaving" means reading all its pods'
logs interleaved, not opening pods one at a time. B7 already interleaves
containers within a pod; this is the same idea one level up, and it's the
feature that makes the Logs tab better than `kubectl logs`.*

**Do:** Backend: `start_workload_logs(kind, ns, name)` resolves the workload's
selector (Deployments/STS/DS — reuse the selector plumbing from
[portforward.rs](src-tauri/src/kube/portforward.rs)'s service resolution),
starts one log pump per matching pod, and multiplexes into a single stream id;
lines carry a `pod` field the way B7 lines carry `container`. Pod set is
re-resolved on a slow tick (~15s) so scale-ups join the stream and gone pods
drop out; the whole bundle registers as *one* entry in the manager (one
watch-count unit, one abort). Frontend: Deployments/STS/DS gain the Logs tab;
the line prefix shows a short pod suffix (`-x2k4n`) tinted with the same
per-source palette the container prefix uses.

**Accept:**
- [ ] Scale a stateless freya Deployment to 2 via the app's own Scale action:
      both pods' lines interleave with distinct prefixes; scale back to 1 and
      the second prefix stops appearing within a tick. (Uses the app to build
      its own multi-pod fixture — freya runs almost everything single-replica.)
- [ ] Search/timestamps/follow/save (B29) work unchanged on workload streams.
- [ ] Closing the tab or navigating away tears down every per-pod pump
      (watch-status returns to baseline — the same proof B15 uses).

## P1 — next

### B32 — Problems view
*Why: the data to answer "is anything wrong?" is already streaming into the
store — it's just scattered across six kinds. freya demonstrates today: two
NotReady nodes, a CrashLoopBackOff, a pod stuck Terminating for 16 days, a
13-day Pending, recurring FailedMount warnings.*

**Do:** A `problems` pseudo-kind at the top of the Cluster group (frontend-only
aggregation, like the namespace pod counts — no new watchers). Sources, each
with a one-line reason: NotReady/unschedulable nodes; pods whose status tone is
err, Pending or Terminating beyond a threshold (10m / 30m); degraded
workloads (ready < desired); failed Jobs; Warning events (already capped and
sorted from B14). Columns: SEVERITY, KIND, OBJECT, REASON, AGE — severity red
before amber, then newest. Rows navigate to the object (sets nav + selects, the
B28/B33 jump). The sidebar item shows a count badge toned by the worst severity
present; zero problems renders a deliberately quiet "nothing wrong" state.

**Accept:**
- [ ] freya today lists: leo + mars NotReady, the wiki crash-looper, the 16-day
      Terminating pod, the 13-day Pending postgres, cb8's FailedMount warnings
      — each with a legible reason, worst first.
- [ ] Clicking the crash-looper row lands on that pod with the detail panel
      open; clicking a node problem lands on the node.
- [ ] The derivation is a pure function over store rows with vitest cases per
      source (including "healthy cluster → empty").

### B33 — Related-resource navigation  ✅ shipped
*Why: the mental model of Kubernetes is a graph; the app shows disconnected
tables. Also closes B14's deliberate v1 gap (events rows aren't clickable).*

> **Shipped — all three jumps.** (1) **Owner link**: a pod's Overview `owner`
> field is a click-through link; a ReplicaSet owner resolves *through* the RS to
> its Deployment backend-side (`resolve_owner`), since we don't list RS.
> (2) **Workload → pods**: a "View pods" action on Deployment/STS/DS drops the
> workload's `matchLabels` into the table filter, which now parses
> `key=value[,k2=v2]` label selectors alongside name substrings
> (`lib/filter.ts`); pods carry `labels`, workloads carry `selector` on the Row.
> (3) **Event → object**: B14 event rows are clickable when the involvedObject's
> kind resolves to a table we list (`navIdForKind`, built-ins + CRDs by
> kind+group); unresolvable kinds stay inert. All navigation goes through a
> shared `jumpPatch` (reused from B28's `jumpTo`) via new store actions
> `navigateTo`/`viewPods`. Live-verified read-only (`examples/related_check`):
> the wiki crash-looper's owner resolves to Deployment/wiki; a real Deployment's
> selector matches its pods; every sampled event carries an involvedObject.
>
> Types widened: `Row` gained `labels`/`selector`/`involved`; properties `Field`
> gained an optional `nav` target; a shared `NavTarget`.

**Do:** Three jumps, all landing as nav + namespace + row selection:
**owner** — the properties Overview's owner field becomes a link; ReplicaSet
owners resolve *through* the RS to its Deployment backend-side (we don't list
RS as a kind); **workload → pods** — a "view pods" affordance on
Deployments/STS/DS rows that jumps to Pods with the workload's selector
applied, which needs the table filter to accept `key=value[,k2=v2]` label
selector syntax alongside name substrings (parser in `lib/filter.ts`,
unit-tested; pods carry labels on the Row for this); **event → object** — B14
rows become clickable when the involved object's kind is one we show, mapping
Kind → nav id (including discovered CRDs by group/kind; unresolvable kinds stay
inert rather than dead-clicking).

**Accept:**
- [x] From the wiki crash-looper's properties, the owner link lands on the
      `wiki` Deployment (resolved through its ReplicaSet) — verified live.
- [x] "View pods" on a workload shows its pods, the selector visible in the
      filter box as removable text (verified the selector matches live pods).
- [x] Event rows are clickable when the involvedObject resolves to a listed kind;
      unlisted kinds (ReplicaSet, Endpoints, wrong-group CRD) render inert.
      *GUI pass still wanted for the click/cursor feel.*

### B34 — Rollout actions: restart & undo
*Why: scale/delete shipped in B3, but the most common workload verb is
`kubectl rollout restart`, and its safety net is `rollout undo`. The B18
properties panel already shows the ReplicaSet revision history this needs.*

> **Restart shipped** (asked for directly: "there should be a way to restart a
> pod"). Two mechanisms, one "Restart…" menu row: a **pod** restarts by
> delete-and-recreate (`restart_pod` refuses a pod with no controller —
> deleting *that* is a delete, not a restart), a **workload**
> (Deployment/STS/DaemonSet) rollout-restarts via the template `restartedAt`
> patch (`restart_rollout`). Pure decisions in `kube/restart.rs`
> (`has_controller`, `restart_patch`, `is_rollout_kind`) with 5 unit tests
> pinning the patch shape and owner check. Live-verified read-only via
> `examples/restart_check`: on freya all 71 pods are controller-owned (no bare
> specimen to show the refusal — the unit test carries that case), and the
> rollout patch is accepted as a **server-side dry run** that echoes the
> annotation onto the template while persisting nothing. Also fixed in passing:
> the Scale/Forward confirm panels referenced `styles.cancelBtn`/`applyBtn`
> that never existed in `DetailPanel.module.css` (only YamlTab's), so those
> buttons had been rendering unstyled — the classes now live in the shared
> module.
>
> **Still open: undo (rollback to revision N)** — the `undo_rollout` half below
> is not built.

**Do:** Backend: `restart_rollout(kind, ns, name)` patches
`spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"]` to
now (the exact mechanism kubectl uses — the annotation *is* the API);
`undo_rollout(ns, name, revision)` for Deployments copies the target
ReplicaSet's pod template back onto the Deployment (revisions come from the
same owner-uid + revision-annotation logic properties.rs already has).
Frontend: "Restart rollout…" (confirm) in the actions menu for
Deployments/STS/DS; "Roll back to revision N…" offered per-row in the
properties ReplicaSets table for non-current revisions, with a red confirm
naming the revision. Progress is already visible — the READY column and
conditions do that job.

**Accept:**
- [x] Unit tests pin the restart patch shape (undo template-copy still pending).
- [x] Live: rollout patch validated server-side (dry run) against a real
      Deployment; the operator does the actual restart — same honesty rule as
      the B20 drain.
- [x] Kinds without rollout semantics don't offer restart (pods get
      delete-and-recreate; jobs/cronjobs/configmaps/etc. get neither).
- [ ] undo_rollout: template-copy test + live rollback to the prior template.

### B35 — Helm release detail: history & values  ✅ shipped
*Why: B26 deliberately shipped list + manifest only. The other two questions
you ask of a release — "what changed between revisions" and "what values is it
running with" — are sitting in the same Secrets we already decode; freya's
releases are all rev 1 today, so history is thin there, but the decode path is
identical.*

> **Shipped.** A Helm release now gets a Properties tab (added `helm` to
> `KINDS_WITH_PROPERTIES`, reusing B18's section renderer). `gather_helm` lists a
> release's revision Secrets by Helm's own `owner=helm,name=…` labels — the
> inverse of B26's `latest_only` — and decodes all of them into: an **Overview**
> (chart, app version, status, first/last deployed, revision, description), a
> **History** table (REVISION/STATUS/CHART/DESCRIPTION/UPDATED, newest first,
> superseded muted / current ok / failed red), and a **Values** table. The
> decoder gained `config` (user overrides) + `first_deployed`; `flatten_values`
> renders overrides as sorted `dotted.path` → value pairs and **redacts any value
> under a `password|secret|token|key` key by name** — the value string never
> leaves Rust. Empty config → "chart defaults (no overrides)". Still zero writes.
> Pure `build_helm_properties` is unit-tested on synthetic v1/v2/v3; live-verified
> via `examples/helm_props_check` (traefik: 13 values; traefik-crd: chart
> defaults; arc: 5 values — all decoded from the cluster, no helm CLI).

**Do:** Selecting a release gains Properties-shaped detail (reuse the B18
section renderer): an Overview (chart, app version, status, first/last
deployed, description), a **History** table — every revision's Secret decoded:
REVISION, STATUS, CHART, DESCRIPTION, UPDATED, newest first (the
`latest_only` reduction already computes the grouping; this is its inverse
view) — and a **Values** section rendering the release's `config` JSON (the
user-supplied overrides; empty → "chart defaults"). Values pass through the
same redaction stance as manifests: keys matching `password|secret|token|key`
render `<redacted>` — a values blob is exactly where credentials end up.
Still zero write operations.

**Accept:**
- [x] freya's `traefik` release shows Overview + a 1-row history + its 13 values;
      `traefik-crd` shows "chart defaults" — all decoded from the cluster, no helm
      CLI (`examples/helm_props_check`).
- [x] Multi-revision history pinned by `helm_history_orders_and_tones` on
      synthetic v1/v2/v3 (newest-first, superseded muted, current deployed ok).
- [x] A `config` with `auth.password`/`dbPassword` renders `<redacted>`; both the
      cargo tests (`flatten_redacts_credentials`, `helm_history_orders_and_tones`)
      assert the value string never reaches the cells.

## P2 — later

### B36 — Create from YAML, and dry-run diff before apply
**Do:** A "+ Create" affordance (topbar or ⌘K action): paste/edit a manifest in
the CodeMirror editor, `create` it via the dynamic API (kind/ns parsed from the
manifest itself). And for *edits*: Apply first sends the replace with
`dryRun=All`, shows a unified diff (current ↔ server-normalized result) in the
editor gutter/panel, and only then offers the real apply — mistakes surface
before the cluster changes, and defaulting/mutation webhooks are visible in
the diff. **Accept:** creating a scratch ConfigMap and a Deployment works (and
gives B34 its live fixture); an edit that a webhook would mutate shows the
mutation in the diff before apply; invalid manifests fail the dry-run with the
server's message, cluster untouched.

### B37 — Secret values: copy without display
**Do:** The app's stance is that Secret values never render (B-series decision,
docs/verification.md) — but *using* a secret is legitimate. Per key in a
Secret's detail: a "copy value" button whose command decodes and writes the
value to the clipboard **in Rust** (`tauri-plugin-clipboard-manager`), so the
plaintext never enters the webview/DOM at all; UI shows only a "copied ✓"
flash. **Accept:** pasted value matches `kubectl get secret … | base64 -d`;
grep the emitted Tauri event traffic to prove the value isn't in it; YAML/table
remain redacted.

### B38 — Prometheus-backed metrics history
**Do:** When a Prometheus service is reachable (detect by conventional
names/labels, query through the API-server service proxy — the transport is
already proven against freya), B27's node charts backfill with
`query_range` history and pods gain CPU/MEM sparklines; the live scraper stays
as the fallback and freshest point. **Accept:** gated on the cluster-side
scrape-target fix (freya's Prometheus currently holds zero `node_*` series —
targets point at a decommissioned IP); until then, query plumbing verifies
against `up`, and the fallback path is what B27 already proves. *Blocked on
operator action; do not start before the scrape config is fixed.*

### B39 — Bulk selection & row context menu
**Do:** Shift/⌘-click multi-select in the table; right-click context menu
mirroring the detail actions menu (delete on N pods with one confirm listing
them; cordon on multiple nodes). Selection state per kind, cleared on nav; the
confirm always enumerates what it's about to do. **Accept:** deleting 3
selected pods of a scaled deployment issues 3 deletes and one confirm;
context-menu actions and detail-panel actions share one implementation (no
drift).

### B40 — Storage: PersistentVolumes & PersistentVolumeClaims  ✅ shipped
*Why: asked for directly. PVs/PVCs existed only as *resolved references* inside a
pod's properties — you could see that a pod was backed by `pvc-5a948cc3…` but
there was no table to open it in, so the reference dead-ended. Storage is also
the one place a cluster quietly runs out of something.*

> **Shipped.** Two new kinds in a new **Storage** nav group:
> `persistentvolumeclaims` (namespaced) and `persistentvolumes` (cluster-scoped),
> claims first — a claim is what a workload references, the volume behind it is
> the follow-up. Columns follow kubectl: claims are
> NAME·NAMESPACE·STATUS·VOLUME·CAPACITY·ACCESS·CLASS·AGE, volumes are
> NAME·CAPACITY·ACCESS·RECLAIM·STATUS·CLAIM·CLASS·AGE (no NAMESPACE; CLAIM
> carries "namespace/name"). Access modes render in kubectl's shorthand
> (RWO/ROX/RWX/RWOP), unknown modes passing through rather than being dropped.
>
> Two things the mapping gets right that the obvious version wouldn't:
> **a Pending claim has no bound capacity**, so CAPACITY falls back to the
> *requested* size — otherwise the column is blank exactly when you're asking how
> big the claim was; and PVs need **their own tone function**, because the shared
> `status_tone` sends anything unrecognised to red, which would paint an
> `Available` (idle, unclaimed) volume as a failure and a `Released` one (claim
> gone, data still there — needs a decision) the same red as `Failed`.
>
> Also registered in B33's Kind→nav map, so an event about a claim is clickable.
> Live-verified via `examples/storage_check`: freya's 9 claims and 9 volumes
> render, and every bound pair cross-references the other consistently.
>
> **Not done:** properties gatherers for either kind (consistent with jobs,
> daemonsets, configmaps etc., which also have tables but no Properties tab).
> *(The PV/CLAIM-cells-aren't-links gap noted here was closed by B41.)*

### B41 — Cell-level nav, ReplicaSets, StorageClasses, volume sources  ✅ shipped
*Why: an audit for "other gaps like the PVs" found the PV work wasn't actually
finished, and that the gap had two different shapes.*

> **The structural half.** B33 put `nav` on a properties `Field`, but most
> references to another object live in a **table**, and `Cell` had no nav — so
> B40's new PV/PVC tables were still unreachable from the pod that used them.
> `NavTarget` moved to `dto.rs`, `Cell` gained an optional `nav`, and one
> `NavLink` component now renders both fields and cells. Wired up: pod
> Overview `node` and StatefulSet `service name` (fields), and the pod's
> Storage (CLAIM/PV/CLASS), Other volumes (SOURCE), Services (NAME) and the
> Deployment's ReplicaSets (NAME) tables.
>
> **The missing-tables half.** `replicasets` (Workloads) and `storageclasses`
> (Storage, cluster-scoped, default class marked in the NAME as kubectl does).
> A 0-desired ReplicaSet reads **muted, not amber** — a superseded generation is
> history, and freya has 45 of them against 28 live, so colouring them as
> degraded would make every Deployment look broken. With ReplicaSets listed,
> `resolve_owner`'s bare-RS fallback finally links instead of dead-ending.
>
> **The ungathered half.** `volume_kind` only ever returned a *classification*,
> so the panel said a pod mounts "a Secret" without saying which. The source name
> is now captured and linked.
>
> **A bug the live check caught in this very change.** `related_links_check`
> resolves every emitted nav target against the API, and found one 404:
> argocd-repo-server mounts `argocd-repo-server-tls` with `optional: true`, and
> that Secret doesn't exist — so linking it produced exactly the dead link this
> item set out to remove. Volume sources are now existence-checked via
> `get_metadata` (deliberately: an existence check must not pull a Secret's
> contents), and an absent source renders `name (not found)` in amber, which is
> itself the answer to "why isn't this config applying". 7/7 links now resolve.
>
> *(The unlisted-kinds list here was worked down by B42.)*

### B42 — The links B41 missed, and ServiceAccounts  ✅ shipped
*Why: re-running the "any other gaps like the PVs?" audit against the post-B41
code found three tables B41 had simply skipped — the same gap, in sites I'd
missed rather than in a new shape.*

> **Three missed tables**, all referencing kinds already listed, all previously
> plain text: Service → **Endpoints** (POD, NODE), StatefulSet → **Persistent
> volume claims** (NAME, CLASS, PV), and StatefulSet → **Volume claim
> templates** (CLASS). A StatefulSet's storage panel had been *entirely*
> dead-ended — the original complaint, one kind over.
>
> **ServiceAccounts** as a kind (Config group, namespaced). Its SECRETS column
> keeps kubectl parity even though it reads 0 on every modern cluster (all 69 of
> freya's): it earns its place by the exception, so a non-zero count — a
> long-lived token attached by hand — is toned amber rather than blending in.
> The pod's `service account` field links there now.
>
> **A second 404, in B41's own code.** The harness caught
> `statefulsets/argocd-application-controller` → a Service that doesn't exist:
> Argo declares a `serviceName` for a headless Service it never creates. B41 had
> *rationalised* this in a comment ("can link somewhere empty — still better
> than making you search by hand"), which contradicts the rule the volume
> sources follow. Now consistent: existence-checked, and a missing one renders
> `name (not found)` in amber — a StatefulSet whose governing Service is absent
> has no stable pod DNS, so that's worth surfacing, not hiding.
>
> The harness also grew a gap of its own: it only walked the *pod* panel, so the
> Service and StatefulSet links it was meant to guard went unchecked, and it
> picked a StatefulSet with no volume claim templates. It now walks every
> gatherer that emits links and prefers a StatefulSet that actually declares
> storage. 15/15 links resolve.
>
> **Still unlisted** (referenced, no table): PriorityClass, IngressClass,
> ControllerRevision, Endpoints. **Never gathered**: imagePullSecrets,
> `env.valueFrom`, Ingress backends (no `gather_ingress` at all), a Helm
> release's installed objects. **Absent entirely**: NetworkPolicies (7 on
> freya), RBAC (16 roles / 83 clusterroles), Leases, APIServices.

---

## Parking lot (one-liners, not yet worth a number)

- **Node debug shell** — Lens-style privileged nsenter pod; powerful, sharp
  edges, needs its own safety design.
- **App auto-update** — tauri-updater riding the B25 release pipeline; wants a
  signing identity first.
- **RBAC-aware actions** — `SelfSubjectAccessReview` to grey out verbs the
  user can't perform instead of failing on click.
- **Watch staleness badge** — a watcher stuck in backoff currently degrades
  silently; surface per-kind staleness in the table header.
- **Copy as kubectl** — per-row "copy kubectl command" (get/describe/logs
  equivalents) for handing to people without k7s.
- **Multi-cluster windows** — one connection per window via Tauri
  multi-window; the ClientManager-per-window boundary already almost allows it.
- **Light theme** — tokens.css is the single source; a second palette is
  mechanical but needs design taste applied.

## Suggested order

B28 → B29 → B30 → B31 (P0) → B32 → B33 → B34 → B35 (P1) → B36 → B37 → B39;
B38 whenever the Prometheus scrape config gets fixed cluster-side.
Dependencies: B33's object-jump is B28's jump machinery reused (build B28
first); B34's live fixture wants B36's create (or a kubectl-made scratch
Deployment); B35 reuses B18's section renderer and B26's decoder as-is.
