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

**Accept:**
- [ ] From Pods, `⌘K wiki` → the crash-looping wiki pod opens with two
      keystrokes and Enter; `⌘K releases` switches to the Helm view;
      `⌘K applications` jumps to the Argo CRD kind (and lazily starts its
      watcher, exactly as clicking the sidebar does).
- [ ] Objects of *unwatched* CRD kinds are absent from results (their rows
      aren't loaded) — the kind itself still matches, and jumping to it loads
      them; no phantom entries.
- [ ] Esc cascade unchanged; palette traps focus; j/k + arrows move the
      selection; the fuzzy scorer's ranking is pinned by vitest cases
      ("wik" ranks `wiki-…` above `kube-wiki-…`).

### B29 — Crash-loop debugging: previous logs, since, save-to-file
*Why: the single most common debugging motion the app can't do today. The
current container of a crash-looper has seconds of logs; the answer is always
in the **previous** container's output. freya has a live specimen with 3258
restarts to prove it on.*

**Do:** Backend: `LogParams.previous` and `since_seconds` threaded through
`start_log_stream` (kube supports both natively). Frontend, in the logs
toolbar: a "previous" toggle (shown only when `restarts > 0`), a since selector
(`5m / 1h / 24h / all` — maps to `since_seconds`, replacing the stream on
change like the container cycler does), and a save button that writes the
*full* current stream to a file via the existing dialog plugin (`.save()`), not
just the ring buffer — the backend re-fetches without `tail` for the export so
the file isn't capped at the on-screen 200 lines.

**Accept:**
- [ ] On `wiki-6b6d775f4-djpwx`, "previous" shows the dying container's last
      output — the actual crash reason, which the live stream never contains.
- [ ] Toggling previous/since swaps streams cleanly (no interleaved old lines,
      follow state preserved); "previous" on a 0-restart pod isn't offered.
- [ ] Saved file contains more lines than the ring buffer cap when the pod has
      them, and ends with the newest on-screen line.

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

### B33 — Related-resource navigation
*Why: the mental model of Kubernetes is a graph; the app shows disconnected
tables. Also closes B14's deliberate v1 gap (events rows aren't clickable).*

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
- [ ] From the wiki crash-looper's properties, the owner link lands on the
      `wiki` Deployment (resolved through its ReplicaSet).
- [ ] "View pods" on `argocd-repo-server` shows exactly its pods, with the
      selector visible in the filter box as removable text.
- [ ] Clicking a FailedMount event on freya lands on the cb8 pod; an event for
      an unlisted kind renders unclickable (cursor/tone say so).

### B34 — Rollout actions: restart & undo
*Why: scale/delete shipped in B3, but the most common workload verb is
`kubectl rollout restart`, and its safety net is `rollout undo`. The B18
properties panel already shows the ReplicaSet revision history this needs.*

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
- [ ] Unit tests pin the restart patch shape and the undo template-copy
      (fixture Deployment + two RS revisions → patch equals old template).
- [ ] Live, against a scratch Deployment created for the test (see B36's
      create-from-YAML; until then, one made with kubectl): restart cycles the
      pod with a new RS revision; undo returns to the prior template.
      *Restarting freya's real workloads is the operator's call — same honesty
      rule as the B20 drain.*
- [ ] Kinds without rollout semantics don't offer the actions.

### B35 — Helm release detail: history & values
*Why: B26 deliberately shipped list + manifest only. The other two questions
you ask of a release — "what changed between revisions" and "what values is it
running with" — are sitting in the same Secrets we already decode; freya's
releases are all rev 1 today, so history is thin there, but the decode path is
identical.*

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
- [ ] freya's `traefik` release shows Overview + a 1-row history + its values
      (or "chart defaults"), all decoded from the cluster, no helm CLI.
- [ ] Multi-revision history is pinned by unit tests on synthetic v1/v2/v3
      Secrets (correct order, superseded toned muted, current toned ok).
- [ ] A values blob containing `dbPassword` shows `<redacted>`; the vitest/
      cargo test proves the value string never reaches the payload.

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
