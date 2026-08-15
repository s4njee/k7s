# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Versioning.** A minor version (0.x) advances per release-map row in
[`backlog-v6.md`](backlog-v6.md) — each row is one themed release; a patch
(0.x.y) is a bug fix. A release is `dev/bump.sh X.Y.Z` → commit → tag
`vX.Y.Z` → push. `dev/bump.sh` keeps the three files that carry the version
(`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`) in sync,
and CI refuses a tag whose three versions disagree.

## [Unreleased]

### Added

- Kind coverage sweep (B80): HorizontalPodAutoscalers (REFERENCE/TARGETS
  columns, tone on `ScalingLimited`), PodDisruptionBudgets (B61's MIN/MAX
  AVAILABLE, CURRENT HEALTHY, DISRUPTIONS ALLOWED), NetworkPolicies, ResourceQuotas
  (used/hard REQUEST/LIMIT like `kubectl get -o wide`), LimitRanges, and the
  Mutating/ValidatingWebhookConfigurations — each with a properties panel. The
  pod panel now answers which PDBs cover it and which NetworkPolicies select it;
  the Namespace panel shows its quota fill (used vs hard, toned at 80%/100%);
  and the drain confirm shows the PDB math *before* committing (a node's
  evictable pods, each budget's allowed disruptions), so a drain that would
  stall on a PDB is visible in advance. The fixture cluster and live harnesses
  (`kinds_check`, `related_links_check`, `drain_check`) cover the new tables and
  every new reference link.
- Automatic updates (B72): `tauri-plugin-updater` with its own Ed25519 signing
  keypair, a passive check in Settings ("Software updates" — current version +
  check/install/restart) and a quiet statusbar badge when a newer version
  exists. The release workflow signs updater artifacts and publishes the
  `latest.json` manifest when `TAURI_SIGNING_PRIVATE_KEY` is a CI secret;
  without it, builds are unchanged and updates simply aren't offered.
- Windows/Linux build scaffolding (B71): CI matrix producing NSIS/MSI and
  AppImage/deb/rpm, a session-end window-state save on Windows, kubeconfig
  separator tests that run on the matrix, and a per-platform QA checklist in
  `docs/verification.md`.
- Diagnostics & supportability (B73): rotating log file under the app log dir
  with a live Settings log-level control; frontend errors (window,
  unhandled-rejection, ErrorBoundary) forwarded to the same log; **File →
  Export Diagnostics…** zips the log tail, versions, redacted settings and the
  last error — scrubbed of server URLs, tokens, secret values and paths, safe
  to attach to a bug report; and opt-in crash reporting (panics + render errors
  only, off by default, no analytics/telemetry — the README says so as a
  feature).
- Security hardening (B75): a real CSP (`default-src 'self'` + the
  style/font/img/connect/worker carve-outs CodeMirror/xterm/plotly and the
  Tauri IPC need, with a dev-only relaxation for vite HMR); the capability set
  narrowed to the explicit minimum the frontend uses; `cargo audit` + `pnpm
  audit` gates and Dependabot in CI; a SECURITY.md with a disclosure contact;
  and a regression test pinning that a hostile pod name renders as text, not
  HTML (there is no `dangerouslySetInnerHTML` anywhere).
- Multi-cluster backend (B76): `ClientManager` is now keyed by cluster — several
  contexts connect side-by-side, each with its own lifecycle (`disconnect(cid)`
  tears down one cluster's watchers/streams/forwards, never anyone else's).
  Every event channel is namespaced by cid (`resource-update:{cid}`,
  `watch-status:{cid}`, `log-line:{cid}:{streamId}`, …) and every command takes
  the cluster id; the frontend passes a single active cid, so switching reuses
  a live connection (no teardown, the backend replays its retained snapshots).
  The store stays single-cluster — the cid-keyed UI is B77. Watch budgets
  deferred to B77. Manager lifecycle unit tests + a live `multi_cluster_check`
  harness.
- Multi-cluster UI (B77): the store is now cid-keyed (rows, metrics, forwards,
  drains, problems, cluster status, nav/namespace/detail per cluster), so
  switching between connected clusters is instant — no teardown, every panel
  re-points at the selected cluster's retained data. The sidebar gains a compact
  **cluster rail** (initial + colour, connection dot, worst-problem tint;
  ⌘1–9 to switch), the Problems view has an "all clusters" scope, notifications
  name their cluster, port-forwards and the detail header are badged by cluster,
  Settings has a per-cluster default namespace, and demo mode now produces
  per-cluster data (a same-named `default/web` pod with distinct status per
  cluster — the no-leakage fixture).
- Scale for the 10k-object cluster (B78): the row path is now **delta-driven** —
  watchers accumulate the changed uids from watch events and emit `upserts`/
  `deletes` keyed by uid instead of re-serialising a full snapshot every
  debounce tick, with a periodic full-snapshot resync as the escape hatch
  (watcher start, the Events kind, and re-switch still send snapshots). The
  store applies deltas by uid; `deriveProblems` is memoised by kind. The table
  only renders the virtual window (`React.memo` on rows, the scroll window
  memoised to row granularity), and high-churn channels (`resource-update`,
  per-node stats) are subscribed for the **active cluster only** — an unviewed
  background cluster costs no IPC while its low-churn rail channels stay live.
  Property tests pin delta ≡ snapshot on both sides.

## [0.5.0] - 2026-08-14

### Added

- CRD printer columns (B30) — discovered CRDs surface their `additionalPrinterColumns` in the table.
- Workload log bundles (B31) — previous/since/save across every pod in a workload at once.
- Problems view (B32) — crash loops, Pending, and eviction risks aggregated from the store.
- Workload rollout undo (B34b) — Deployment/StatefulSet/DaemonSet rollback to a prior revision.
- Discovery-based live harnesses (B45) — the `examples/*_check.rs` probes now find their own fixtures at runtime, so they run against any cluster.
- Pod resource sparklines with request/limit overlays (B44, B58), and appearance settings with a File → Settings menu (B44).
- Reference-link gap fixes (B46) — pod References section (image pull secrets, env sources), Helm release Objects table, PVC "mounted by" / PV state / ReplicaSet owner panels.
- Resource creation from YAML with a dry-run preview (B36), TLS certificate inspection via `x509-parser` (B48), RBAC kinds (B49), native desktop notifications (B50), a Diff tab against the last-applied/managed-fields baseline (B54), a topology graph (B55), per-context bookmarks (B56), and an event timeline (B57).
- MIT license, this changelog, and single-sourced versioning — `dev/bump.sh` + a CI consistency check (B69).

## [0.4.0] - 2026-07-25

### Added

- First CI-tagged release. Everything built since v0.1 lands here: Helm releases decoded from their storage Secrets; node CPU/memory/network plots from node-exporter with Prometheus backfill (B27, B38); the command palette (B28); a settings panel (B23); window-state persistence (B22); persisted kubeconfig imports (B17); CRD support with custom kinds folded under their API group (B15); properties, events, logs and dry-run-diff detail panels; exec shells and port-forwards (B4/B6/B16); drain/cordon/scale/restart actions (B3, B20); light/dark themes, node debug shells and bulk selection (B52/B53/B39); and release CI (B25).

### Fixed

- Clippy warnings that blocked the `-D warnings` gate, which CI enforces.

## [0.1.0] - 2026-07-15

### Added

- Initial release: the Lens-style Kubernetes monitor — live resource tables with filtering, sorting and keyboard navigation; detail panels with streaming logs; exec shells; port-forwarding; and persisted state (B1–B12).
