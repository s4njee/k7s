# k7s — Backlog v5: New Feature Ideas

Fresh ideas for the next wave of k7s development. Numbering continues from B53.
Conventions follow [backlog.md](backlog.md) — **Do**/**Accept** format, clippy
`-D warnings` + `cargo test` + `tsc` + `vitest` + live/demo verification.

---

## P0 — Highest priority

### B54 — Resource diff: live vs. last-applied
*Why: "someone changed something and now it's broken" is the #1 debugging
scenario. The app already has a diff engine (B36a) and YAML view, but can't
answer "what changed since deploy". The `last-applied-configuration` annotation
or server-side-apply managed-fields metadata is already on every object —
unused.*

**Do:** A **Diff** tab in the detail panel showing the delta between the live
object and its `last-applied-configuration` annotation (falling back to a
managed-fields reconstruction when the annotation is absent). Reuse
`lib/diff.ts` with the same hunk rendering as the apply-preview. Syntax
highlighting via the existing CodeMirror integration. A "no baseline available"
state when neither source exists.

**Accept:**
- [ ] A Deployment modified via `kubectl edit` (adding a label) shows the delta
      in the Diff tab, matching `kubectl diff` output semantically.
- [ ] Objects with no last-applied annotation and no managed-fields show a clean
      empty state, not an error.
- [x] Unit tests cover the annotation-parse and managed-fields reconstruction
      paths.

---

### B55 — Resource topology graph
*Why: the Properties panel answers "what is this wired to" as a list; a graph
answers "how does traffic flow from Ingress to Pod" visually. The related-resource
navigation (B33) already resolves all these edges — this is a rendering surface,
not new data.*

**Do:** A **Topology** view (detail panel tab or a top-level nav item) rendering
the ownership and reference graph for the selected resource and its neighborhood.
Nodes are resources (icon + short name); edges are ownership (solid) or reference
(dashed). Layout: a simple left-to-right DAG using a basic layered algorithm
(no external graph library — a Sugiyama-lite over the known edge types is
tractable). Clicking a node navigates. Canvas-rendered (HTML `<canvas>`) for
performance; light/dark palette from design tokens.

**Accept:**
- [ ] A Deployment shows: Deployment → ReplicaSet → Pods, with Service and
      Ingress referencing the pods via selector. *(live graph verified on kind —
      `topology_check` prints the chain)*
- [ ] Clicking a graph node opens that resource's detail panel.
- [ ] Graph renders correctly in both light and dark themes.
- [ ] Demo mode renders a plausible graph from mock data.

---

### B56 — Resource bookmarks & quick-access
*Why: power users monitor the same 5–10 resources constantly. The command
palette (B28) finds anything, but the user has to type every time. Bookmarks
are the "recent contacts" of cluster management.*

**Do:** A **Bookmarks** section at the top of the sidebar (collapsible, below
the cluster switcher). Bookmark a resource from the detail panel header or row
context menu (B39). Persisted per-context in the same prefs store as window state
(B22). Each bookmark shows kind icon + name + live status tone (pulled from the
existing store rows, so no new watchers). Stale bookmarks (resource deleted)
show a muted "not found" state. ⌘K integration: bookmarked items rank higher.

**Accept:**
- [ ] Bookmarking a pod from the detail panel adds it to the sidebar; clicking
      it navigates.
- [x] Switching contexts loads that context's bookmarks (per-context map,
      store-tested).
- [x] A bookmarked resource that gets deleted shows the muted state; re-creating
      it revives the bookmark (status is derived live from the store rows).
- [x] Bookmark state survives app restart (persisted per-context through the
      prefs round-trip).

---

## P1 — Next

### B57 — Resource event timeline
*Why: the Events tab is a flat list sorted by time. For a pod that's been
crash-looping for hours, the interesting question is "what's the pattern" —
are restarts accelerating, is there a correlation with node events? A timeline
makes periodicity visible.*

**Do:** A visual **Timeline** in the Events tab (toggle between list and
timeline view). Horizontal time axis, events as marks colored by type
(Normal/Warning). Cluster into swim-lanes by involved object when viewing
workload-level events (B31's scope). Zoom/pan with mouse wheel and drag.
Canvas-rendered, token-palette colors. Falls back to the list view when there
are fewer than 5 events (a timeline of 3 dots isn't useful).

**Accept:**
- [ ] A crash-looping pod shows a repeating pattern of BackOff + Started events
      visually.
- [ ] Hovering an event mark shows the full event details.
- [ ] Zoom in/out works smoothly; panning doesn't lose events.
- [ ] List toggle preserves scroll position when switching back.

---

### B58 — Container resource usage vs. limits overlay
*Why: "is this pod right-sized?" is the question after "is it healthy?". The
app shows metrics (B44) and shows limits (Properties), but never together. The
answer requires opening two tabs and doing arithmetic.*

**Do:** In the pod detail's Metrics section (B44), overlay the pod's resource
requests and limits as horizontal reference lines on the CPU/MEM sparklines.
Requests as a dashed line, limits as a solid line. When current usage exceeds
80% of the limit, tint the area amber; above 95%, red. Tooltip shows the exact
values. Data source: the pod spec (already in the store row) for limits, the
existing Prometheus/metrics-server queries for actuals.

**Accept:**
- [ ] A pod with `resources.limits.cpu: 500m` shows a solid line at 500m on the
      CPU sparkline.
- [ ] Usage approaching the limit turns amber/red as specified.
- [ ] A pod with no limits set shows sparklines without overlay lines (no
      visual noise).
- [ ] Requests vs. limits lines are visually distinct (dashed vs. solid).

---

### B59 — Log pattern detection & anomaly highlighting
*Why: scrolling through 13k log lines (argocd-application-controller) looking
for "the one that's different" is the reason people install log aggregators.
Detecting structural anomalies client-side is tractable for the scale the app
handles (single-pod streams, not cluster-wide).*

**Do:** A lightweight log pattern analyzer in Rust: tokenize log lines into
templates (replace numbers/UUIDs/IPs/timestamps with placeholders), count
template frequency, and flag lines whose template appears ≤3 times in the
visible window as **anomalies** — highlighted with a subtle left-border accent.
An "Anomalies only" filter toggle in the log toolbar (alongside B29's existing
filters). Pattern extraction runs incrementally as lines arrive, not as a batch
over the full buffer.

**Accept:**
- [ ] In a stream with 1000 repeated "health check OK" lines and 2 stack traces,
      the stack traces are highlighted.
- [ ] "Anomalies only" filter shows just the rare lines.
- [ ] Pattern detection doesn't add visible latency to log streaming (benchmark:
      <5ms per 100 lines on the ring buffer).
- [ ] Lines with no recognizable pattern (all-unique streams) show no highlights
      (degrade to no-op, not "everything is anomalous").

---

### B60 — Saved views (filter + sort + namespace presets)
*Why: "show me the failing pods in production" is a filter+namespace+sort
combination the user rebuilds every session. The app has all the filter
machinery (B2, filter.ts) but no way to persist a combination.*

**Do:** Named saved views: a filter expression + namespace selection + sort
column + sort direction + optional kind. Save from the table toolbar ("Save
view…"), load from a dropdown or ⌘K. Stored per-context in prefs (same store
as bookmarks/window state). A handful of built-in defaults: "All warnings",
"CrashLoopBackOff pods", "Pending resources". Saved views are editable and
deletable.

**Accept:**
- [ ] Saving a view with `status=CrashLoopBackOff` + namespace `wiki` + sorted
      by RESTARTS desc, then loading it, restores all three parameters.
- [ ] Built-in views work on any cluster (they're filter expressions, not
      hardcoded names).
- [ ] Views survive app restart.
- [ ] ⌘K lists saved views with a "view:" prefix for discoverability.

---

### B61 — Pod disruption budget (PDB) awareness in the UI
*Why: drain (B20) already respects PDBs server-side, but the user can't see
them. "Why won't this node drain?" is unanswerable without `kubectl get pdb`.*

**Do:** PodDisruptionBudgets as a listed kind in the Workloads group. Columns:
NAME, NAMESPACE, MIN AVAILABLE, MAX UNAVAILABLE, CURRENT HEALTHY, DISRUPTIONS
ALLOWED, AGE. The pod detail's Properties section shows which PDBs select it
(selector match, same logic drain uses implicitly). The node drain confirmation
(B20) lists affected PDBs and their current allowed-disruptions count, so the
user sees *before* draining whether it will succeed or stall.

**Accept:**
- [ ] PDB table shows correct values matching `kubectl get pdb`.
- [ ] A pod's Properties section lists the PDBs whose selector matches it.
- [ ] The drain confirmation shows PDB constraints for the node's pods.
- [ ] A cluster with no PDBs shows the kind in the sidebar with count 0.

---

### B62 — Resource annotations & labels editor
*Why: labels and annotations are how Kubernetes tracks intent — adding a label
is how you add a pod to a Service's selector, and annotations control
everything from Ingress routing rules to Argo rollout strategies. Currently the
only way to modify them is full YAML edit (B36a), which is error-prone.*

**Do:** A dedicated **Labels & Annotations** section in the Properties panel
with inline edit affordances: add, edit value, remove — each as a focused
`PATCH` operation (not a full object PUT). Labels show which selectors they
satisfy (Services, Deployments) as linked references. A confirmation for
removing labels that would deselect the resource from an active controller
("removing `app=web` will remove this pod from Service `web-svc`").

**Accept:**
- [ ] Adding a label to a pod via the editor is reflected in `kubectl get` and
      in the app's own table within one watch cycle.
- [ ] Removing a label that a Service selects on shows the warning with the
      Service name.
- [ ] Annotation values with long content (e.g., last-applied-config) are
      shown truncated with expand-on-click.
- [ ] The editor is read-only for Helm-managed resources (same guard as B36a's
      `ensure_writable`).

---

## P2 — Later

### B63 — Multi-cluster overview
*Why: the parking-lot mentions multi-cluster windows. Before full multi-window
support, a read-only overview answers "are all my clusters healthy?" without
switching contexts. The kubeconfig already lists all contexts.*

**Do:** A **Clusters** landing view (shown when no context is connected, or
via a sidebar toggle): one card per kubeconfig context showing connection
status, node count, and a traffic-light health indicator (green/amber/red based
on the Problems derivation — B32 — if connected, grey if not). Clicking a card
connects to that context (the existing switch flow). Health polling: connect
briefly to each context on a slow schedule (~60s), run the problem derivation,
disconnect. Opt-in per context (not every context is reachable from every
network).

**Accept:**
- [ ] With 3 kubeconfig contexts, the Clusters view shows 3 cards with status.
- [ ] A context with a CrashLoopBackOff shows amber/red.
- [ ] Clicking a card connects and navigates to the pods table.
- [ ] Unreachable contexts show a "connection failed" state, not a crash.

---

### B64 — Kubectl command preview
*Why: from the parking lot ("copy as kubectl"). Every action the app takes has
a kubectl equivalent. Showing it builds trust ("what will this actually do?")
and teaches kubectl to users who are learning.*

**Do:** Every action confirmation dialog (scale, restart, drain, delete,
cordon, create, apply) shows a collapsible "kubectl equivalent" section at the
bottom with the exact command. A copy button. The command is constructed from
the action parameters, not reverse-engineered from the API call — so it matches
what a user would type. Format: `kubectl <verb> <kind>/<name> -n <ns> [flags]`.

**Accept:**
- [ ] Scaling a Deployment to 3 replicas shows
      `kubectl scale deployment/web -n default --replicas=3`.
- [ ] Drain shows the full `kubectl drain` with `--ignore-daemonsets` and
      `--delete-emptydir-data` flags matching the app's behavior.
- [ ] Copy button puts the command on the clipboard.
- [ ] Commands for bulk actions show one command per resource.

---

### B65 — Resource cost estimation
*Why: "how much does this namespace cost?" is a question platform teams get
daily. The data exists: pod resource requests × node instance cost. The app
already has requests (pod spec) and node info (node detail). The missing piece
is a cost-per-core/GB config.*

**Do:** Settings: per-cluster cost configuration (CPU $/core/hr, memory
$/GB/hr — or pick from presets for common cloud instance families). A
**Cost** column on the pods table (request-based, not usage-based — the
billing model). Namespace-level aggregation shown in the namespace selector
dropdown. A tooltip breaking down CPU vs. memory cost. Cost data is
frontend-only computation (no new backend queries).

**Accept:**
- [ ] With cost config set to $0.05/core/hr and $0.01/GB/hr, a pod requesting
      1 core + 2GB shows $0.07/hr.
- [ ] Namespace selector shows total cost per namespace.
- [ ] Unconfigured clusters show no cost data (no zeros, no placeholders).
- [ ] Changing cost config updates all displayed values immediately.

---

### B66 — GitOps drift detection
*Why: teams using Argo CD or Flux want to know "is this resource in sync with
Git?" The app already shows Argo Application sync status (B30's CRD printer
columns), but for individual resources there's no signal.*

**Do:** For clusters with Argo CD: detect drift by reading the Application
resource's `.status.resources[]` entries (which list every managed object and
its sync/health status). In the resource table, a **SYNC** column for objects
owned by an Argo Application, with values `Synced` / `OutOfSync` / `Unknown`
toned green/amber/grey. The detail panel shows which Application manages it,
linking to the Application resource. For non-Argo clusters, the column is
absent.

**Accept:**
- [ ] A resource deliberately drifted (`kubectl edit` on an Argo-managed
      Deployment) shows `OutOfSync` in the table.
- [ ] The detail panel links to the managing Application.
- [ ] Clusters without Argo show no sync column (no noise).
- [ ] Works with both Argo CD v2.x Application CRDs.

---

### B67 — Customizable table columns
*Why: different teams care about different metadata. A security team wants
IMAGE and SERVICE ACCOUNT prominent; a platform team wants NODE and COST. The
table has fixed per-kind columns today.*

**Do:** A column picker (gear icon in the table header): show/hide columns,
reorder via drag-and-drop, and add custom columns from label or annotation
values (e.g., "show `team` label as a column"). Persisted per-kind per-context
in prefs. A "reset to defaults" option. Custom columns evaluate against store
row labels/annotations — no new backend queries.

**Accept:**
- [ ] Hiding the NAMESPACE column removes it; reopening the picker shows it
      unchecked.
- [ ] Adding a custom column from label `app` shows the label values for each
      row.
- [ ] Column order is preserved across app restarts.
- [ ] Reset restores the original column set and order.

---

### B68 — Container image vulnerability summary
*Why: "is this image safe?" is asked every time a pod is inspected. The app
shows the image name but says nothing about its known vulnerabilities. Clusters
running Trivy Operator (or similar) already have VulnerabilityReport CRDs.*

**Do:** If the cluster has `aquasecurity.github.io` CRDs (Trivy Operator):
read VulnerabilityReport resources and surface a severity summary
(Critical/High/Medium/Low counts) on the pod detail panel next to the image
name. A red tone when Critical > 0. Link to the full VulnerabilityReport
resource (it's a CRD — B15 already lists it). For clusters without Trivy, no
UI change.

**Accept:**
- [ ] A pod with a VulnerabilityReport showing 2 Critical vulns displays
      "2C / 5H / 12M / 3L" with red tone.
- [ ] Clicking the summary navigates to the VulnerabilityReport CRD resource.
- [ ] Clusters without Trivy Operator show the image name with no badge.
- [ ] Multiple containers in a pod each show their own summary.

---

## Parking lot (one-liners, not yet worth a number)

- **Plugin / extension system** — let users write custom detail panel sections
  or table columns in JS, loaded from a local directory.
- **Audit log viewer** — stream and filter the API server's audit log when
  available (requires audit policy configuration).
- **Resource quota awareness** — show namespace ResourceQuotas and how close
  the namespace is to its limits.
- **Pod scheduling explainer** — when a pod is Pending, show *why*: unmet node
  affinity, insufficient resources, taints without tolerations (parsed from
  events + pod spec + node state).
- **Config map / Secret diff across namespaces** — "is production config the
  same as staging?" side-by-side diff.
- **Terminal multiplexer** — multiple shell tabs per pod, or split-pane shells
  to different pods.
- **JSON log pretty-printer** — detect JSON-structured log lines and render
  them formatted with collapsible keys.
- **Resource dependency validation** — before deleting a ConfigMap, show which
  pods/deployments reference it.
- **Ephemeral container injection** — `kubectl debug`-style: inject a debug
  container into a running pod without restart.
- **Cluster comparison** — diff resource sets between two contexts ("what's in
  staging that isn't in prod?").

---

## Suggested order

B54 → B55 → B56 (P0, foundational UX) → B57 → B58 → B59 → B60 → B61 → B62
(P1, depth and polish) → B63 → B64 → B65 → B66 → B67 → B68 (P2, power
features).

Dependencies: B55 builds on B33's reference graph; B57 extends B31's
workload-level event scope; B58 layers on B44's sparklines; B59 needs the
Rust log pipeline; B63 reuses B32's problem derivation; B66 reads B30's CRD
discovery. Everything else is independent.
