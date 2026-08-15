# k7s — Backlog v6: the road to a professional Lens alternative

This backlog reframes the project. v1–v5 built a *feature surface* — and it's a
genuinely deep one (49 backend commands, 25 built-in kinds plus lazy CRDs, logs/
exec/port-forward/Helm/RBAC/metrics, a full mock provider, 187 Rust unit tests
and 18 live harnesses). What it hasn't built is a *product*: something a
stranger can download, install without incantations, connect to their EKS
cluster, and trust with production. That is what "professional alternative to
Lens" means, and it's mostly not features — it's distribution, auth, resilience,
multi-cluster, and proof.

Numbering continues from B68. Conventions follow [backlog.md](backlog.md):
**Do**/**Accept**, DoD is clippy `-D warnings` + `cargo test` + `tsc` + `vitest`
+ live/demo verification, colors from tokens only. Open v5 items (B59–B68) are
not restated here — the release map below says where each one slots in.

---

## Where the project actually stands

Honest inventory, verified against the tree (2026-08-14):

**Strong** — kind coverage incl. CRDs with printer columns; detail panels
(logs/YAML+dry-run-diff/events+timeline/properties/topology/metrics/shell);
actions with blast-radius-appropriate confirms; Problems view + native
notifications; Prometheus backfill; light/dark themes; demo mode; the
discovery-based live harnesses.

**Missing, structural**
- **One cluster, hard.** `ClientManager` holds `Option<Client>`; `connect()`
  calls `reset()` and aborts every task. One `connection` object in the store,
  un-namespaced events. No second connection exists anywhere in the design.
- **Zero app-level auth code.** Whatever `kube` does implicitly, surfaced as a
  raw error string when it fails. No exec-plugin PATH handling, no re-auth
  prompt, no cluster-add wizard.
- **No extension system.** Adding a kind means editing 4+ files in lockstep.

**Missing, operational**
- No LICENSE (public repo, all-rights-reserved by default). CI builds
  macOS-arm64 only, unsigned and unnotarised; users must clear quarantine by
  hand. No auto-updater (`tauri-plugin-updater` absent). Version lives in three
  files kept in sync manually. No changelog.
- No diagnostics: `tracing` to stderr only — a user running the bundled .app
  has nothing to attach to a bug report. No opt-in crash reporting.
- `"csp": null` in tauri.conf.json.
- Tests are pure-logic only (no component render tests, no e2e); the live
  harnesses don't run in CI.
- Accessibility: 14 aria/role attributes total; the canvas views (timeline,
  topology) have no text alternative.

**Missing, parity** — no cluster overview/dashboard landing page; no Helm write
path (install/upgrade/rollback/repos); no integrated kubectl terminal; kind
gaps (HPA, NetworkPolicy, ResourceQuota/LimitRange, webhooks, PDB=B61); no
workspaces/cluster grouping.

## The bar

"Professional" is testable. Each claim below becomes acceptance criteria
somewhere in this backlog:

1. **Install without instructions.** Signed artifacts for macOS (both arches),
   Windows, Linux; double-click and it opens.
2. **Connect to the big three.** EKS/GKE/AKS kubeconfigs — exec plugins, token
   expiry, SSO — connect or fail with a message that says what to do next.
3. **Stays honest under failure.** Expired creds, dropped VPN, RBAC-denied
   kinds, a watcher in backoff — all *visible states*, never silent staleness.
4. **More than one cluster.** Side by side, without teardown.
5. **Updates itself** and tells you what changed.
6. **Fails loudly to the developer.** A crash or a bug produces something
   actionable (log file, redacted report bundle) without asking the user to
   run from a terminal.
7. **Provable quality.** e2e smoke in CI, live harnesses against a kind
   cluster in CI, a11y at least keyboard-and-focus complete.

## Release map

| Release | Theme | Items |
|---|---|---|
| v0.5 | **Installable & trustworthy** | B69 license/changelog · B70 signing · B71 Win/Linux · B72 auto-update · B73 diagnostics · B75 hardening |
| v0.6 | **Connects anywhere** | B74 auth & resilience · carry: B60 saved views, B64 kubectl preview |
| v0.7 | **Multi-cluster** | B76 backend · B77 UI · B78 scale |
| v0.8 | **Depth & parity** | B79 overview dashboard (absorbs B63) · B80 kind sweep (absorbs B61) · B81 Helm write · B82 kubectl terminal · carry: B62 labels editor, B66 drift, B67 columns |
| v0.9 | **Extensible & proven** | B83 e2e · B84 accessibility · B85 extensions v1 |
| v1.0 | **Launch** | B86 docs & launch kit · carry: B59 log anomalies, B65 cost, B68 Trivy |

The order is deliberate: distribution before features, because every later
item's verification gets cheaper once CI produces signed, updatable builds on
three platforms; auth before multi-cluster, because multi-cluster multiplies
every auth failure mode; extensions late, because a plugin API freezes whatever
internal seams exist when it ships.

---

## P0 — v0.5: installable & trustworthy

### B69 — License, changelog, version single-sourcing
*Why: the repo is public and all-rights-reserved; nobody can legally use it.
The version is hand-synced across package.json, Cargo.toml and tauri.conf.json;
releases have generated notes and no durable changelog. This is an afternoon of
work blocking everything downstream (an updater needs a versioning policy; a
launch needs a license).*

**Do:** Pick a license (MIT or Apache-2.0 — Lens went from MIT to proprietary,
which is exactly the wedge a k7s pitch uses; permissive is the point). Add
`CHANGELOG.md` (Keep-a-Changelog format), backfilled at release granularity
from the git log. A `dev/bump.sh` that sets the version in all three files and
stamps the changelog, so a release is `bump → tag → push`. Document the policy:
0.x minor per release-map row, patch for fixes.

**Accept:**
- [ ] LICENSE renders on the GitHub landing page; `package.json`/`Cargo.toml`
      carry the matching SPDX id.
- [ ] `dev/bump.sh 0.5.0` leaves the tree with one consistent version and a
      changelog section; CI fails a tag whose three versions disagree.
- [ ] CHANGELOG.md covers v0.1→current at least one line per release.

### B70 — Signed & notarised macOS builds
*Why: today's artifact triggers Gatekeeper refusal; "right-click → Open" in a
README is the single loudest "not a real product" signal. The CI comments
already say exactly what's missing: an Apple Developer ID and the secrets wired
into the tauri-action step.*

**Do:** Obtain the Developer ID; add `APPLE_CERTIFICATE`/`APPLE_ID` secrets;
sign + notarise + staple in release.yml. Add an `aarch64`+`x86_64` matrix (or a
universal binary — decide by measuring the size cost) so Intel Macs stop being
excluded. Harden the runner path: notarisation failures fail the build, not
just warn.

**Accept:**
- [ ] A fresh macOS machine (no dev tools) downloads the DMG from a release,
      double-clicks, and the app opens with no quarantine dance.
- [ ] `spctl -a -vv` on the shipped .app reports accepted / notarised.
- [ ] Both architectures are downloadable (or one universal artifact ≤ agreed
      size budget), each smoke-launched in CI.

### B71 — Windows & Linux, first-class
*Why: Lens is cross-platform; a "professional alternative" that is
macOS-arm64-only is a demo. The code already gestures at it — Windows menu
handling in lib.rs, `;` kubeconfig separators and `USERPROFILE` in client.rs —
but nothing has ever been built or run there, and the SIGTERM window-state save
is `#[cfg(unix)]` with no Windows equivalent.*

**Do:** CI matrix jobs on `windows-latest` and `ubuntu-latest` producing
NSIS/MSI and AppImage+deb+rpm. Fix the platform gaps the build surfaces:
window-state persistence on Windows (session-end hook or on-change saves),
font rendering, xterm/webview quirks (WebView2 vs WebKitGTK), file dialogs,
notification behavior. A per-platform manual QA checklist in
docs/verification.md (connect, logs, shell, forward, YAML apply, theme) run
once per release. Windows signing can lag (EV certs are their own saga) — but
the artifacts must exist and work unsigned first.

**Accept:**
- [ ] Release CI attaches working artifacts for all three OSes; each is
      launched in CI at least to first-window-paint (tauri-driver or a
      screenshot probe).
- [ ] The QA checklist passes on a real Windows 11 and Ubuntu 24.04 machine
      against the kind fixture cluster.
- [ ] Window state survives an OS-initiated close on Windows (the `#[cfg(unix)]`
      gap is closed).
- [ ] Platform-conditional code paths (`menu`, kubeconfig separator, config
      dirs) have unit tests that run on the CI matrix, not just macOS.

### B72 — Auto-update
*Why: a monitoring tool that users must manually re-download stays on the
version with the bug. tauri-plugin-updater rides the same release pipeline B70
signs; the parking lot has wanted this since v4 ("wants a signing identity
first" — B70 provides it).*

**Do:** `tauri-plugin-updater` with its own signing keypair (private key in CI
secrets, public key in tauri.conf). Update manifest generated by the release
workflow. In-app UX: Settings shows current version + "check for updates";
a passive statusbar/badge notice when an update is available (never a modal
nag); install-on-restart. Respect the changelog: the update notice links the
CHANGELOG section for the new version.

**Accept:**
- [ ] An app at vN, with vN+1 released, surfaces the update within a day
      (or on manual check), downloads, verifies the signature, and relaunches
      updated — verified on macOS and Windows.
- [ ] A tampered artifact (wrong signature) is rejected loudly.
- [ ] "Check for updates" against the latest version says so quietly; airgapped
      machines degrade to nothing (no error toasts on every launch).

### B73 — Diagnostics & supportability
*Why: today the only diagnostics are stderr and the React ErrorBoundary —
neither exists for someone running the bundled app. Every bug report from a
real user currently starts with "can you run it from a terminal with
RUST_LOG=debug", which professionals read as amateur hour.*

**Do:** `tracing` to a rotating file under the app log dir (platform-correct
locations), level configurable in Settings, secrets never logged (audit the
existing spans — the B37/B48 redaction stance extends to logs). Frontend errors
and unhandled rejections forwarded to the same log via a command. A Help →
"Export diagnostics" that zips: app log (last N MB), versions (app/OS/cluster),
settings with paths+context-names redacted, and the last ErrorBoundary trace.
**Opt-in** crash reporting (Sentry or self-hosted GlitchTip; default off,
plainly worded consent in Settings) for panics and ErrorBoundary hits only —
no analytics, no usage telemetry, ever; say so in the README as a feature.

**Accept:**
- [ ] A panic in a watcher task and a thrown render error both land in the log
      file with stack traces; the file rotates at the cap.
- [ ] The diagnostics zip contains no kubeconfig contents, no tokens, no secret
      values, no server URLs — verified by a test that greps a generated bundle
      after a session against the fixture cluster.
- [ ] With crash reporting off (default), zero network calls to the reporting
      endpoint — verified by proxy capture.

### B75 — Security hardening pass
*Why: the app holds cluster-admin credentials; its own posture should survive a
skeptical platform team's review. `"csp": null` is indefensible for a webview
that renders arbitrary cluster-supplied strings (log lines, event messages,
CRD column values are all attacker-influenced text).*

**Do:** A real CSP (the app loads no remote content — fonts are bundled, so
`default-src 'self'` + the style/worker carve-outs CodeMirror/xterm/plotly
need). Audit Tauri capabilities (`capabilities/default.json`) to the minimal
set. Supply-chain gates in CI: `cargo audit`/`cargo deny` + `npm audit`
(fail on high), Dependabot. A SECURITY.md with a disclosure contact. Verify the
injection surfaces: cluster-supplied strings must never reach `innerHTML`/
`dangerouslySetInnerHTML` (grep + a test rendering a `<script>`-named pod from
the mock provider).

**Accept:**
- [ ] CSP enabled; every view (incl. charts, terminal, QR dialog) works under
      it in the packaged app.
- [ ] A pod named `<img src=x onerror=alert(1)>` in demo mode renders as text
      everywhere it appears (table, detail header, palette, problems).
- [ ] CI fails on a known-vulnerable dependency; SECURITY.md published.

## P1 — v0.6: connects anywhere

### B74 — Cloud auth UX & connection resilience
*Why: the #1 real-world failure mode. EKS/GKE/AKS kubeconfigs all use exec
plugins (`aws`, `gke-gcloud-auth-plugin`, `kubelogin`); a packaged GUI app does
not inherit the shell PATH, so the plugin binary isn't found and today the user
gets a raw `AppError::Kube` string. Expired SSO sessions surface the same way.
There is zero app-level auth code — client.rs is 318 lines of kubeconfig
parsing. This item is the difference between "works on my kind cluster" and
"works at work".*

**Do:** Four parts.
1. **Exec-plugin PATH resolution:** resolve the login-shell PATH on macOS/Linux
   (the Lens/VS Code trick: spawn the user's shell with `-ilc 'echo $PATH'`,
   cache it) and search it for exec commands; per-context override in Settings
   for the stubborn cases. Windows: registry/user PATH.
2. **Error taxonomy:** classify connect/watch failures in Rust — auth-expired,
   plugin-missing (with the exact binary name), unreachable, TLS, RBAC-denied —
   as a typed enum over the wire (extend `AppError` beyond Display strings).
   Each class gets a distinct UI treatment with the *next action* ("run `aws
   sso login`", "install gke-gcloud-auth-plugin", "check VPN") instead of a
   stack of serde noise.
3. **Re-auth flow:** on auth-expired, a non-destructive banner with a Reconnect
   button that retries the exec plugin (which may itself pop a browser); watch
   state resumes without losing UI state. Auto-retry with backoff for
   unreachable (VPN blips), capped and visible.
4. **Staleness surfacing** (parking-lot promotion): a watcher in backoff marks
   its kind's table header and sidebar count with a stale badge + last-update
   age; the statusbar dot goes amber when any watcher is degraded. Silence is
   the failure mode being killed here.

**Accept:**
- [ ] An EKS context whose SSO session has expired shows "credentials expired —
      run `aws sso login`", and Reconnect succeeds after doing so, without an
      app restart. (Live check against a real EKS/GKE cluster — this needs a
      cloud fixture; a free-tier GKE autopilot or EKS on a scratch account is
      part of the item.)
- [ ] The packaged .app (launched from Finder, not a terminal) connects to a
      context using an exec plugin installed via Homebrew.
- [ ] Killing the network mid-session: tables mark stale within a poll tick,
      statusbar goes amber, recovery clears both without a reconnect click.
- [ ] `error.rs` variants map to distinct UI states, pinned by unit tests; no
      raw `Display` strings shown for the classified cases.

## P2 — v0.7: multi-cluster

### B76 — Multi-cluster backend
*Why: the single largest structural gap vs Lens, and the parking lot has
carried it since v4. `ClientManager` is one `Option<Client>` and `connect()`
resets the world. Everything downstream (events, store, watch counts) assumes
one cluster. Doing the backend first, behind the existing single-cluster UI,
keeps the change reviewable.*

**Do:** Rework `ClientManager` into a keyed map of per-cluster connection
states (client + task registries + status), each with its own lifecycle
(`connect(ctx)` no longer resets others; `disconnect(ctx)` tears down one).
Namespace every event by a cluster id (`resource-update:{cid}` or a `cid`
field — pick one, migrate all 14 event channels), and every command takes the
cluster id. Per-cluster watch budgets (the lazy-CRD discipline already exists —
apply it cluster-wide so 3 clusters ≠ 3× idle load; kinds not being viewed can
degrade to slow list-polls on background clusters). The frontend provider
passes a single active cid through unchanged — UI behavior is identical this
release.

**Accept:**
- [ ] Two contexts connected simultaneously in a test harness; events carry
      the right cid; disconnecting one leaves the other's streams running
      (watch-status proves it, per-cluster).
- [ ] Switching the active cluster in the UI is now O(instant) — no teardown,
      no reconnect, tables render from the retained store. (The old switch
      tore down everything; this is the user-visible payoff even before B77.)
- [ ] `reset()` semantics preserved per-cluster: shells/forwards/log streams
      die with *their* cluster only. Manager unit tests cover the keyed
      lifecycle.

### B77 — Multi-cluster UI
*Why: the payoff surface. Lens's core loop is many clusters in one window.*

**Do:** The store's `connection`, `rows`, metrics, forwards, drains, problems
become cid-keyed (the slices already isolate these — extend types, don't
scatter). Sidebar grows a compact cluster rail: per-cluster identity (initial +
user-set color, stored in prefs), connection dot, worst-problem tint; click
switches, ⌘1–9 hotkeys. Problems view gains an "all clusters" scope; native
notifications carry the cluster and say it. Port-forward bar and shells are
badged by cluster so an exec into prod is never ambiguous with staging.
Per-cluster settings page (accent, default namespace, poll intervals — the
prefs schema is already per-context-shaped for bookmarks).

**Accept:**
- [ ] Two clusters connected: switching is instant, every panel (table, detail,
      forwards, problems, statusbar) shows the selected cluster's data only,
      and nothing leaks across (fixture: same-named `default/web` pod in both
      clusters — demo mode gets a second mock cluster for exactly this).
- [ ] A CrashLoopBackOff on the *background* cluster raises its rail badge and
      a notification naming the cluster.
- [ ] A shell tab and a port-forward opened on cluster A keep working while
      viewing cluster B, visibly labeled A.
- [ ] Bookmarks, saved views (B60) and column prefs (B67) remain per-cluster.

### B78 — Scale: the 10k-object cluster
*Why: plan.md's own caveat — full-snapshot events "fine at hobby-cluster
scale... revisit if a table exceeds ~5k rows". Professional clusters exceed it.
Multi-cluster (B76) multiplies the cost. The VITE_STRESS=5000 fixture exists;
nothing measures the Rust→IPC→store path, which re-serializes every row on
every debounce tick.*

**Do:** Benchmark first (a `stress_check` harness: synthetic reflector feeding
N rows at M churn; measure IPC bytes/sec, store-set time, dropped frames), then
fix what it indicts — likely: delta row updates (add/update/delete keyed by
uid) with a full-snapshot resync escape hatch, per-kind emit only when that
kind is visible, and IPC payload trimming (cells-only rows for tables, full
objects on selection). Table virtualization already exists; verify it holds at
10k with sorting and filtering applied (both are O(n) per render today —
memoize).

**Accept:**
- [ ] 10k pods at 50 updates/sec: UI stays interactive (no >100ms frames while
      scrolling — measured, in CI where feasible, else a scripted local run
      recorded in the item's verification note), memory bounded.
- [ ] Delta path proven equivalent to snapshots by a property test (same final
      store state under reordering/races), with resync covering watcher
      restarts.
- [ ] Two connected clusters at 5k objects each: background cluster costs no
      IPC while unviewed (event counters prove it).

## P3 — v0.8: depth & parity

### B79 — Cluster overview dashboard *(absorbs B63)*
*Why: Lens opens on a cluster landing page; k7s opens on a pods table. "Is the
cluster OK and where is it heading" has no single surface — the data is already
in the store (problems, node stats, metrics, events) and in promql.rs.*

**Do:** A per-cluster **Overview** nav item (top of Cluster group, default
landing after connect): capacity gauges (CPU/mem requests vs allocatable vs
usage — metrics-server or Prometheus, degrading per the B38 rule), node grid
(one tile per node, tone by condition), problems digest (top 5, linking into
B32's view), recent Warning events sparkline, workload counts by health, top-5
consumers (from existing pod metrics). Multi-cluster (B77) gets the "all
clusters" card grid version of the same — that is B63's scope, absorbed here.

**Accept:**
- [ ] The fixture cluster's overview shows its standing defects (crash-looper,
      Pending pod) in the digest, correct node tiles, and plausible capacity
      numbers cross-checked against `kubectl describe nodes`.
- [ ] No metrics stack → gauges degrade to requests-vs-allocatable (spec math
      only), not blanks.
- [ ] Demo mode renders the full dashboard; screenshots regenerated
      (`dev/shots.mjs`) — this page becomes the README hero image.

### B80 — Kind coverage sweep *(absorbs B61)*
*Why: 25 built-in kinds vs Lens's catalogue. The absentees users hit weekly:
HPA (why is this scaling?), NetworkPolicy (why can't this connect?),
ResourceQuota/LimitRange (why won't this schedule?), PDB (why won't this drain?
— B61), webhooks (why was this mutated/rejected?), EndpointSlices.*

**Do:** Add kinds: HorizontalPodAutoscaler (current/target metrics, tone on
ScalingLimited), PodDisruptionBudget (B61's spec verbatim, incl. drain-confirm
integration), NetworkPolicy (with the parking lot's pod-panel "which policies
select this pod" join — that's the useful half), ResourceQuota + LimitRange
(namespace panel shows quota fill), Mutating/ValidatingWebhookConfiguration,
EndpointSlices (under the Service panel rather than a nav item). Each with
properties gatherers and reference links per the ref_cell discipline. Extend
`related_links_check` to walk the new panels.

**Accept:**
- [ ] Each new kind's table matches its `kubectl get` counterpart on the
      fixture cluster (extend `dev/cluster` manifests with an HPA, a PDB, a
      NetworkPolicy, a ResourceQuota).
- [ ] A pod's panel answers: which PDBs cover it, which NetworkPolicies select
      it; a namespace answers quota fill; drain confirm shows PDB math (B61's
      accepts inherited).
- [ ] `related_links_check`: all new links resolve, 0 broken.

### B81 — Helm write path
*Why: k7s decodes releases read-only; Lens installs, upgrades, rolls back.
Rollback is the killer feature during an incident, and the storage-Secret
format is already fully understood by helm.rs.*

**Do:** Phase 1 (this item): **rollback** (write a new release Secret from
revision N's stored chart+values — the same mechanic `helm rollback` uses) and
**uninstall** (delete release Secrets + manifest objects, enumerated in the
confirm via the existing Objects table). Phase 2 (separate item when wanted):
repos + install/upgrade, which drag in chart fetching, rendering and value
editing — deliberately deferred; shelling out to a user-installed `helm` binary
is the pragmatic fallback and must be weighed against embedding
`helm`-as-a-library honestly before phase 2 is scoped.

**Accept:**
- [ ] Rolling back the fixture cluster's release to revision N−1 produces the
      same cluster state as `helm rollback` (manifest diff empty), and `helm
      history` shows the new revision as a rollback — interop proven, both
      directions.
- [ ] Uninstall removes the release and its objects, confirm enumerating them
      first; a release with a missing manifest object degrades gracefully.
- [ ] Both actions refuse cleanly when the release Secret's owner isn't Helm 3
      storage v1 (never guess at v2 layouts).

### B82 — Integrated kubectl terminal
*Why: Lens ships a terminal wired to the selected cluster; every escape hatch
the app doesn't cover (custom flags, plugins, muscle memory) lives there. k7s
has xterm.js, exec plumbing, and per-context kubeconfig export (the QR feature)
— all three ingredients exist.*

**Do:** A per-cluster **Terminal** tab (statusbar affordance + ⌘T): spawns the
user's shell (portable-pty on the Rust side) with `KUBECONFIG` pointed at a
temp single-context file (the `export_context_kubeconfig` output, 0600,
deleted on close) so `kubectl` targets the viewed cluster with zero setup.
Detect a missing kubectl and say so (with the install hint per-OS). Reuse the
exec-plugin PATH resolution from B74. Multiple terminals; cluster-badged tabs
like shells (B77).

**Accept:**
- [ ] `kubectl get pods` in the terminal matches the app's table, with no
      environment setup, on a machine whose default context differs from the
      viewed cluster.
- [ ] The temp kubeconfig never outlives the session (orphan sweep on start,
      the nodeshell discipline) and is 0600.
- [ ] Works on all three OSes (Windows: PowerShell default) — part of the B71
      QA checklist thereafter.

## P4 — v0.9: extensible & proven

### B83 — End-to-end test harness
*Why: 380 vitest assertions and 187 Rust tests, all pure logic — nothing
renders a component or drives the real app. Every regression so far was found
by hand-driving the UI (B39's two bugs said so explicitly). Professional means
CI catches those.*

**Do:** Two layers. (1) **Component tests**: React Testing Library over the
demo-mode app for the interaction contracts (open detail, tab switch, palette
jump, filter, multi-select, confirm dialogs) — fast, hermetic, on every push.
(2) **App e2e**: WebDriver via tauri-driver (Linux CI runner) against the kind
fixture cluster for the golden path: connect → pods table → open crash-looper
→ logs stream → YAML dry-run diff → scale ±1 → problem appears/clears. Wire
the 18 existing `examples/*_check.rs` harnesses into a CI job against the kind
cluster (they were built discovery-based for exactly this — B45 — and then
never put in CI).

**Accept:**
- [ ] PRs run component tests; a broken tab-switch or dialog fails red.
- [ ] Nightly (or per-PR if runtime allows) e2e job stands up kind, runs the
      golden path + all live harnesses, tears down; flake rate <5% over a week
      before it gates merges.
- [ ] A deliberately broken build (revert a store fix) fails the harness —
      the trap proves the net.

### B84 — Accessibility pass
*Why: 14 aria attributes app-wide; canvas timeline/topology are invisible to
assistive tech; modal focus is unmanaged. Table-stakes for professional
software and for any org with procurement standards.*

**Do:** Focus management: modals (settings, create, confirms, palette) trap
and restore focus; a visible focus-ring policy in tokens (not the browser
default, not `outline: none`). Semantics: nav/table/tablist/dialog roles,
aria-labels on every icon-only control, live-region announcements for row-count
changes and action results. Canvas fallbacks: timeline and topology get
data-equivalent DOM lists (the data is already in the store; render it
`visually-hidden` or as an explicit toggle). Contrast audit of both palettes
against WCAG AA (tones on dark are the risk). Keyboard-complete: every action
reachable without a pointer (the vim keys exist; close the gaps — context-menu
actions, forward bar, bookmark toggle).

**Accept:**
- [ ] Full session (connect → find pod → read logs → scale) completed with
      VoiceOver on macOS and NVDA on Windows by script.
- [ ] axe-core in the component tests (B83): zero serious/critical on every
      view in both themes.
- [ ] Tab order and focus restore verified for every modal; the palette is
      operable with a screen reader (results announced).

### B85 — Extension system v1
*Why: Lens's moat is its extension API; the parking lot has carried "plugin
system" since v5. k7s can't and shouldn't chase API breadth — but a small,
honest extension surface turns "tool I use" into "platform my team invests
in". v1 is deliberately declarative-first: the highest-value extensions
(company CRD views) need data, not code.*

**Do:** Extensions as directories under an `extensions/` app dir, manifest +
assets, loaded at start, togglable in Settings. Two capability tiers in v1:
(1) **Declarative** (JSON/YAML, no code): custom columns for any kind
(JSONPath over the object — jsonpath.rs exists), custom detail-panel sections
(field lists with ref-links), kind grouping/ordering/icons. (2) **JS render
extensions** (sandboxed iframe, message-port API, versioned schema): a custom
tab for a kind receiving the selected object + a scoped read-only data API
(get object, list related, no exec/no mutations in v1). Publish the schema as
`k7s-extension-api` types; two example extensions in-repo (an Argo Rollouts
panel is the perfect dogfood — freya runs Argo). Explicit non-goals in the
doc: no npm marketplace, no mutation API, until the schema survives two
releases unbroken.

**Accept:**
- [ ] The example declarative extension adds a column and a panel section to a
      CRD without touching k7s source; removing the directory removes them.
- [ ] The JS example renders a custom tab; it cannot invoke Tauri commands
      (capability test: attempted `invoke` from the sandbox fails), cannot
      read another kind than granted.
- [ ] A manifest targeting a newer API version is refused with a clear message;
      loaded extensions and their versions are listed in Settings and in the
      B73 diagnostics bundle.

## v1.0 — launch

### B86 — Docs site & launch kit
*Why: professional products have docs that aren't a README, and an adoption
path that isn't "clone the repo". This is the wrapping on everything above —
it ships last and blocks calling anything 1.0.*

**Do:** A docs site (static — Astro/Starlight or mdBook — published via Pages
from `docs/`): install per-OS, connecting to EKS/GKE/AKS (the B74 flows,
screenshotted), features tour keyed to the demo-mode screenshots (regenerated
by `dev/shots.mjs` — automate into CI so they never rot), keyboard reference
(the useGlobalKeys/useTableKeys maps, generated from code), extension authoring
(B85 schema), troubleshooting (the B74 error taxonomy, verbatim). An honest
**k7s vs Lens** page: what k7s does (fast, native, open, no account, no
telemetry), what it doesn't (no marketplace, no cloud features) — the
no-account/no-telemetry stance is the positioning, print it. Repo kit:
issue/PR templates, CONTRIBUTING.md (the DoD conventions from this file),
support matrix (OS/k8s versions tested — pin what CI actually proves),
GitHub Discussions on.

**Accept:**
- [ ] docs URL live; every install path tested from its own docs page on a
      clean machine.
- [ ] Screenshot regeneration runs in CI; a stale screenshot fails the build.
- [ ] The keyboard reference page is generated from the key-map source, not
      hand-maintained (drift-proof).
- [ ] v1.0.0 tagged only when: B69–B86 closed or explicitly re-scoped, support
      matrix published, and the e2e suite (B83) green for two consecutive
      releases.

---

## Carried forward from backlog-v5 (still open, unchanged)

B59 log anomalies · B60 saved views · B61 PDB *(absorbed into B80)* ·
B62 labels editor · B63 multi-cluster overview *(absorbed into B79)* ·
B64 kubectl preview · B65 cost estimation · B66 GitOps drift ·
B67 custom columns *(note: B85's declarative columns should share one
implementation with this)* · B68 Trivy summary.
Slotting per the release map; specs in [backlog-v5.md](backlog-v5.md).

## Small fixes (do in passing, no number needed)

- `dry_run_yaml` is registered twice in `generate_handler!`
  (src-tauri/src/lib.rs — lines 88 and 92).
- `@tauri-apps/plugin-notification` is a dead frontend dependency
  (notifications fire from Rust); drop it from package.json.
- The three-way version sync becomes a CI check under B69.

## Parking lot (v6)

- **i18n** — no framework today, all-English; defer until an actual non-English
  contributor or customer shows up, then it's a real (large) item.
- **Helm phase 2** — repos, chart browsing, install/upgrade (see B81).
- **Workspaces** — named groups of clusters above B77's rail; wants real
  multi-cluster usage feedback first.
- **RBAC-aware actions** (carried from v4) — `SelfSubjectAccessReview` to grey
  out forbidden verbs; pairs naturally with B74's error taxonomy.
- **Persistent port-forwards** (carried from v4) — re-establish on reconnect;
  easier after B76's per-cluster lifecycles.
- **Ephemeral debug containers**, **audit log viewer**, **cluster comparison**,
  **JSON log pretty-printer**, **terminal multiplexer** — carried from v5.
- **Metrics stack installer** — Lens offers one-click Prometheus install;
  k7s's degrade-gracefully stance may be the better opinion. Revisit on demand.

## Suggested order

B69 → B70 → B71 → B72 → B73 → B75 (v0.5, strict order: license before
publicity, signing before updater) → B74 (+B60, B64) → B76 → B77 → B78 →
B79 → B80 → B81 → B82 (+B62, B66, B67) → B83 → B84 → B85 → B86 (+B59,
B65, B68).

Dependencies: B72 needs B70's signing identity; B74's PATH resolution is
reused by B82; B76 blocks B77/B78 and simplifies persistent forwards; B79
reuses B32's derivation and promql.rs; B80 extends the fixture cluster that
B83's e2e then depends on; B85's declarative columns and B67 are one
implementation; B86 documents everything and therefore ships last.
